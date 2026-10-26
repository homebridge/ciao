/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import net from "net";
import { DNSResponseDefinition, RType } from "./coder/DNSPacket";
import { AAAARecord } from "./coder/records/AAAARecord";
import { ARecord } from "./coder/records/ARecord";
import { NSECRecord } from "./coder/records/NSECRecord";
import { PTRRecord } from "./coder/records/PTRRecord";
import { SRVRecord } from "./coder/records/SRVRecord";
import { TXTRecord } from "./coder/records/TXTRecord";
import { ResourceRecord } from "./coder/ResourceRecord";
import { SERVICE_TYPE_ENUMERATION_NAME } from "./dns-sd";
import { Protocol } from "./index";
import { InterfaceName, IPAddress, NetworkManager, NetworkUpdate } from "./NetworkManager";
import { Announcer } from "./responder/Announcer";
import { dnsLowerCase } from "./util/dns-equal";
import { escapeLabel, splitLabels, wireLength } from "./util/dns-labels";
import * as domainFormatter from "./util/domain-formatter";
import { formatReverseAddressPTRName } from "./util/domain-formatter";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:CiaoService");

// A service name numbered like "My Service (2)", and a hostname's last own label, raw, numbered like "My-Computer-(2)".
const numberedServiceNamePattern = /^(.*) \((\d+)\)$/;
const numberedHostnameLabelPattern = /^(.*)-\((\d+)\)$/;

/* The label a rename numbers: the raw base cut to its longest prefix that leaves room for the suffix within the octets the label may take, and the suffix
 * after it, the base read raw because a label in presentation form would be measured by its escapes too. The cut steps by grapheme cluster, the character
 * a reader sees, so a flag, a letter with its combining accent or an emoji sequence is kept or dropped whole. A runtime without Intl.Segmenter, such as a
 * Node built without Intl, steps by code point instead, as for...of iterates, which never splits a surrogate pair. When the first cluster alone is wider
 * than the room, no part of the base fits and the label is the suffix alone. When the suffix alone passes the octets no prefix fits, and the rename is
 * refused with the sentence naming what it renames.
 */
function numberedLabel(base: string, suffix: string, octets: number, renamed: string): string {
  let room = octets - Buffer.byteLength(suffix);

  if (room < 0) {
    throw new Error(renamed + " has no prefix that fits with the number '" + suffix + "' in the " + octets + " octets its label may take, within the 63 " +
      "a DNS label and the 255 a DNS name may hold.");
  }

  if (Buffer.byteLength(base) <= room) {
    return base + suffix;
  }

  // A segmenter is built on each call, as a cut runs only on a conflict rename, so no module state holds one and the guard reads the runtime as it stands.
  const characters: Iterable<string> = (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function")?
    Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(base), segment => segment.segment): base;
  let prefix = "";

  for (const character of characters) {
    room -= Buffer.byteLength(character);

    if (room < 0) {
      break;
    }

    prefix += character;
  }

  return prefix + suffix;
}

/**
 * This enum defines some commonly used service types.
 * This is also referred to as service name (as of RFC 6763).
 * A service name must not be longer than 15 characters (RFC 6763 7.2).
 */
export const enum ServiceType {
  // noinspection JSUnusedGlobalSymbols
  AIRDROP = "airdrop",
  AIRPLAY = "airplay",
  AIRPORT = "airport",
  COMPANION_LINK = "companion-link",
  DACP = "dacp", // digital audio control protocol (iTunes)
  HAP = "hap", // used by HomeKit accessories
  HOMEKIT = "homekit", // used by home hubs
  HTTP = "http",
  HTTP_ALT = "http_alt", // http alternate
  IPP = "ipp", // internet printing protocol
  IPPS = "ipps", // internet printing protocol over https
  RAOP = "raop", // remote audio output protocol
  scanner = "scanner", // bonjour scanning
  TOUCH_ABLE = "touch-able", // iPhone and iPod touch remote controllable
  DNS_SD = "dns-sd",
  PRINTER = "printer",
}

/**
 * Service options supplied when creating a new ciao service.
 */
export interface ServiceOptions {
  /**
   * Instance name of the service
   */
  name: string;
  /**
   * Type of the service.
   */
  type: ServiceType | string;
  /**
   * Optional array of subtypes of the service.
   * Refer to {@link ServiceType} for some known examples.
   */
  subtypes?: (ServiceType | string)[];
  /**
   * Port of the service.
   * If not supplied it must be set later via {@link CiaoService.updatePort} BEFORE advertising the service.
   */
  port?: number;

  /**
   * The protocol the service uses. Default is TCP.
   */
  protocol?: Protocol;
  /**
   * Defines a hostname under which the service can be reached.
   * The specified hostname must not include the TLD. It is a domain name in DNS presentation form, so a dot separates labels and a backslash escapes the
   * character after it, and each space in it becomes a dash.
   * If undefined, the hostname is derived from the service name as one label, in which each space and each dot becomes a dash.
   */
  hostname?: string;
  /**
   * If defined, a txt record will be published with the given service.
   */
  txt?: ServiceTxt;

  /**
   * Adds ability to set custom domain. Will default to "local".
   * The domain will also be automatically appended to the hostname.
   * Creating the service throws when a label of the domain is empty or takes more than 63 octets, with an error naming the hostname it is appended to, or
   * when the domain carries the service's full name past 255 octets on the wire, with an error naming that name.
   */
  domain?: string;

  /**
   * If defined it restricts the service to be advertised on the specified
   * ip addresses or interface names.
   *
   * If an interface name is specified, ANY address on that given interface will be advertised
   * (if an IP address of the given interface is also given in the array, it will be overridden).
   * If an IP address is specified, the service will only be advertised for the given addresses.
   *
   * Interface names and addresses can be mixed in the array.
   * If an ip address is given, the ip address must be valid at the time of service creation.
   *
   * If the service is set to advertise on a given interface, though the MDNSServer is
   * configured to ignore this interface, the service won't be advertised on the interface.
   */
  restrictedAddresses?: (InterfaceName | IPAddress)[];
  /**
   * The service won't advertise ipv6 address records.
   * This can be used to simulate binding on 0.0.0.0.
   * May be combined with {@link restrictedAddresses}.
   */
  disabledIpv6?: boolean;
}

/**
 * A service txt consist of multiple key=value pairs,
 * which get advertised on the network.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceTxt = Record<string, any>;

/**
 * @private
 */
export const enum ServiceState {
  UNANNOUNCED = "unannounced",
  PROBING = "probing",
  PROBED = "probed", // service was probed to be unique
  ANNOUNCING = "announcing", // service is in the process of being announced
  ANNOUNCED = "announced",
}

/**
 * @private
 */
export interface ServiceRecords {
  ptr: PTRRecord; // this is the main type ptr record
  subtypePTRs?: PTRRecord[];
  metaQueryPtr: PTRRecord; // pointer for the "_services._dns-sd._udp.local" meta query

  srv: SRVRecord;
  txt: TXTRecord;
  serviceNSEC: NSECRecord;

  a: Record<InterfaceName, ARecord>;
  aaaa: Record<InterfaceName, AAAARecord>; // link-local
  aaaaR: Record<InterfaceName, AAAARecord>; // routable AAAA
  aaaaULA: Record<InterfaceName, AAAARecord>; // unique local address
  reverseAddressPTRs: Record<IPAddress, PTRRecord>; // indexed by address
}

/**
 * Events thrown by a CiaoService
 */
export const enum ServiceEvent {
  /**
   * Event is called when the Prober identifies that the name for the service is already used
   * and thus resolve the name conflict by adjusting the name (e.g. adding ' (2)' to the name).
   * A name the number would carry past the 63 octets of a DNS label, or past the 255 of a DNS name with
   * the rest of the service's name, is shortened first, on a character boundary, so the new name can be shorter than the old one.
   * This change must be persisted and thus a listener must hook up to this event
   * in order for the name to be persisted.
   */
  NAME_CHANGED = "name-change",
  /**
   * Event is called when the Prober identifies that the hostname for the service is already used
   * and thus resolve the name conflict by adjusting the hostname (e.g. adding '-(2)' to its last label, ahead of the domain).
   * That label is shortened first, as the name is, when the number would carry it past the 63 octets of a DNS label or the
   * hostname past the 255 of a DNS name. The event reports the hostname without the domain.
   * The name change must be persisted. As the hostname is an optional parameter, it is derived
   * from the service name if not supplied.
   * If you supply a custom hostname (not automatically derived from the service name) you must
   * hook up a listener to this event in order for the hostname to be persisted.
   */
  HOSTNAME_CHANGED = "hostname-change",
}

/**
 * Events thrown by a CiaoService, internal use only!
 * @private
 */
export const enum InternalServiceEvent {
  PUBLISH = "publish",
  UNPUBLISH = "unpublish",
  REPUBLISH = "republish",
  RECORD_UPDATE = "records-update",
}

/**
 * @private
 */
export type PublishCallback = (error?: Error) => void;
/**
 * @private
 */
export type UnpublishCallback = (error?: Error) => void;
/**
 * @private
 */
export type RecordsUpdateCallback = (error?: Error | null) => void;

export declare interface CiaoService {

  on(event: "name-change", listener: (name: string) => void): this;
  on(event: "hostname-change", listener: (hostname: string) => void): this;

  /**
   * @private
   */
  on(event: InternalServiceEvent.PUBLISH, listener: (callback: PublishCallback) => void): this;
  /**
   * @private
   */
  on(event: InternalServiceEvent.UNPUBLISH, listener: (callback: UnpublishCallback) => void): this;
  /**
   * @private
   */
  on(event: InternalServiceEvent.REPUBLISH, listener: (callback: PublishCallback) => void): this;
  /**
   * @private
   */
  on(event: InternalServiceEvent.RECORD_UPDATE, listener: (response: DNSResponseDefinition, callback?: (error?: Error | null) => void) => void): this;

  /**
   * @private
   */
  emit(event: ServiceEvent.NAME_CHANGED, name: string): boolean;
  /**
   * @private
   */
  emit(event: ServiceEvent.HOSTNAME_CHANGED, hostname: string): boolean;

  /**
   * @private
   */
  emit(event: InternalServiceEvent.PUBLISH, callback: PublishCallback): boolean;
  /**
   * @private
   */
  emit(event: InternalServiceEvent.UNPUBLISH, callback: UnpublishCallback): boolean;
  /**
   * @private
   */
  emit(event: InternalServiceEvent.REPUBLISH, callback?: PublishCallback): boolean;
  /**
   * @private
   */
  emit(event: InternalServiceEvent.RECORD_UPDATE, response: DNSResponseDefinition, callback?: (error?: Error | null) => void): boolean;

}

/**
 * The CiaoService class represents a service which can be advertised on the network.
 *
 * A service is identified by its fully qualified domain name (FQDN), which consist of
 * the service name, the service type, the protocol and the service domain (.local by default).
 *
 * The service defines a hostname and a port where the advertised service can be reached.
 *
 * Additionally, a TXT record can be published, which can contain information (in form of key-value pairs),
 * which might be useful to a querier.
 *
 * A CiaoService class is always bound to a {@link Responder} and can be created using the
 * {@link Responder.createService} method in the Responder class.
 * Once the instance is created, {@link advertise} can be called to announce the service on the network.
 */
export class CiaoService extends EventEmitter {

  private readonly networkManager: NetworkManager;

  private name: string;
  private readonly type: ServiceType | string;
  private readonly subTypes?: string[];
  private readonly protocol: Protocol;
  private readonly serviceDomain: string; // remember: can't be named "domain" => conflicts with EventEmitter

  private fqdn: string; // fully qualified domain name
  private loweredFqdn: string;
  private readonly typePTR: string;
  private readonly loweredTypePTR: string;
  private readonly subTypePTRs?: string[];

  private hostname: string; // formatted hostname
  private loweredHostname: string;
  private port?: number;

  private readonly restrictedAddresses?: Map<InterfaceName, IPAddress[]>;
  private readonly disableIpv6?: boolean;

  private txt: Buffer[];
  private txtTimer?: Timeout;

  /**
   * this field is entirely controlled by the Responder class
   * @private use by the Responder to set the current service state
   */
  serviceState = ServiceState.UNANNOUNCED;
  /**
   * If service is in state {@link ServiceState.ANNOUNCING} the {@link Announcer} responsible for the
   * service will be linked here. This is need to cancel announcing when for example the service
   * should be terminated, and we still aren't fully announced yet.
   * @private is controlled by the {@link Responder} instance
   */
  currentAnnouncer?: Announcer;
  private serviceRecords?: ServiceRecords;

  private destroyed = false;
  /**
   * Whether the service is meant to be on the network: set by {@link advertise}, and cleared only by {@link end} and {@link destroy}. A queued
   * advertisement reads it at its turn and is dropped once it is cleared, while the retry after a failed probe and every republish, which re-enter the
   * Responder without passing through {@link advertise}, find it still set.
   */
  private advertisementIntent = false;

  /**
   * Constructs a new service. Please use {@link Responder.createService} to create new service.
   * When calling the constructor a callee must listen to certain events in order to provide
   * correct functionality.
   * @private used by the Responder instance to create a new service
   */
  constructor(networkManager: NetworkManager, options: ServiceOptions) {
    super();
    assert(networkManager, "networkManager is required");
    assert(options, "parameters options is required");
    assert(options.name, "service options parameter 'name' is required");
    assert(options.type, "service options parameter 'type' is required");
    assert(options.type.length <= domainFormatter.MAX_SERVICE_TYPE_LENGTH,
      "service options parameter 'type' must not be longer than " + domainFormatter.MAX_SERVICE_TYPE_LENGTH + " characters");

    this.networkManager = networkManager;

    this.name = options.name;
    this.type = options.type;
    this.subTypes = options.subtypes;
    this.protocol = options.protocol || Protocol.TCP;
    /* The domain is held in the spelling the label coder decodes, each label split and escaped again, so the FQDN, the type PTR and the hostname built from
     * it are the names a received packet carries. It is split as the end of a name, ahead of the root label, so a last label ending in an escaped dot stays
     * one label.
     */
    const domainLabels = splitLabels((options.domain || "local") + ".").slice(0, -1);

    // A domain written absolute, "local." for "local", ends with the root label every name built from it appends anyway, so that one label is dropped. It is
    // dropped only after a filled label, so no domain is emptied, as "." would be, and every refusal names each label written, as the refusal of "local.." does.
    if (domainLabels[domainLabels.length - 1] === "" && domainLabels[domainLabels.length - 2] !== "") {
      domainLabels.pop();
    }

    this.serviceDomain = domainLabels.map(escapeLabel).join(".");

    this.fqdn = this.formatFQDN();
    this.loweredFqdn = dnsLowerCase(this.fqdn);

    this.typePTR = domainFormatter.stringify({ // something like '_hap._tcp.local'
      type: this.type,
      protocol: this.protocol,
      domain: this.serviceDomain,
    });
    this.loweredTypePTR = dnsLowerCase(this.typePTR);

    if (this.subTypes) {
      this.subTypePTRs = this.subTypes.map(subtype => domainFormatter.stringify({
        subtype: subtype,
        type: this.type,
        protocol: this.protocol,
        domain: this.serviceDomain,
      })).map(dnsLowerCase);
    }

    /* A derived hostname is one DNS label, so a dot in the service name becomes a dash one for one, as a space does, and the label escape keeps a backslash
     * literal through the escape-aware split.
     */
    const hostname = domainFormatter.formatHostname(options.hostname || escapeLabel(this.name.replace(/\./g, "-")), this.serviceDomain)
      .replace(/ /g, "-"); // replacing all spaces with dashes in the hostname
    this.hostname = hostname;
    this.loweredHostname = dnsLowerCase(this.hostname);

    this.port = options.port;

    if (options.restrictedAddresses) {
      assert(options.restrictedAddresses.length, "The service property 'restrictedAddresses' cannot be an empty array!");
      this.restrictedAddresses = new Map();

      for (const entry of options.restrictedAddresses) {
        if (net.isIP(entry)) {
          // An IPv6 entry is canonicalized, and that text is what the unspecified-address check, the interface resolution and the stored list use, so a
          // consumer's spelling selects the interface it names and matches the interface map's canonical text; an error message keeps the consumer's spelling.
          const address = net.isIPv6(entry)? domainFormatter.canonicalizeIPv6(entry): entry;

          if (address === "0.0.0.0" || address === "::") {
            throw new Error(`[${this.fqdn}] Unspecified ip address (${entry}) cannot be used to restrict on to!`);
          }

          const interfaceName = NetworkManager.resolveInterface(address);
          if (!interfaceName) {
            throw new Error(`[${this.fqdn}] Could not restrict service to address ${entry} as we could not resolve it to an interface name!`);
          }

          const current = this.restrictedAddresses.get(interfaceName);
          if (current) {
            // empty interface signals "catch all" was already configured for this
            if (current.length && !current.includes(address)) {
              current.push(address);
            }
          } else {
            this.restrictedAddresses.set(interfaceName, [address]);
          }
        } else {
          this.restrictedAddresses.set(entry, []); // empty array signals "use all addresses for interface"
        }
      }
    }
    this.disableIpv6 = options.disabledIpv6;

    this.txt = options.txt? CiaoService.txtBuffersFromRecord(options.txt): [];

    /* The call aligns the numbers a persisted name and hostname carry, and it rebuilds the hostname's own labels, each split and escaped again. That rebuild
     * is where an explicit hostname, a domain name in presentation form, is spelled once the way the label coder decodes it, so a backslash before any other
     * character is dropped as the wire drops it, and the hostname the service holds is the one a received packet carries.
     */
    this.incrementName(true);
  }

  /**
   * This method start the advertising process of the service:
   *  - The service name (and hostname) will be probed unique on all interfaces (as defined in RFC 6762 8.1).
   *  - Once probed unique the service will be announced (as defined in RFC 6762 8.3).
   *
   *  The returned promise resolves once the service was probed unique and its announcement has started. A probe query that could not be sent
   *  is retried after a delay, and the promise resolves once a retry gets through. It also resolves, without announcing, when the advertisement
   *  is withdrawn first: by {@link end}, by {@link destroy} or by the shutdown of the Responder. A second call while the service is still probing
   *  resolves once that probing, and any advertisement queued behind it, has settled. The promise rejects when the service is already announced.
   */
  public advertise(): Promise<void> {
    assert(!this.destroyed, "Cannot publish destroyed service!");
    assert(this.port, "Service port must be defined before advertising the service on the network!");

    if (this.listeners(ServiceEvent.NAME_CHANGED).length === 0) {
      debug("[%s] WARN: No listeners found for a potential name change on the 'name-change' event!", this.name);
    }

    this.advertisementIntent = true;
    return new Promise((resolve, reject) => {
      this.emit(InternalServiceEvent.PUBLISH, error => error? reject(error): resolve());
    });
  }

  /**
   * This method will remove the advertisement for the service on all connected network interfaces.
   * If the service is still in the Probing state, probing will simply be cancelled. An advertisement still waiting for its turn to probe,
   * or for a retry, is dropped, and its {@link advertise} promise resolves without announcing.
   *
   * @returns Promise will resolve once the last goodbye packet was sent out, or failed to send, and at once for a service that is not announced
   */
  public end(): Promise<void> {
    assert(!this.destroyed, "Cannot end destroyed service!");
    this.advertisementIntent = false;

    if (this.serviceState === ServiceState.UNANNOUNCED) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.emit(InternalServiceEvent.UNPUBLISH, error => error? reject(error): resolve());
    });
  }

  /**
   * This method must be called if you want to free the memory used by this service.
   * The service instance is not usable anymore after this call.
   *
   * If the service is still announced, the service will first be removed
   * from the network by calling {@link end}.
   *
   * @returns
   */
  public async destroy(): Promise<void> {
    const endPromise = this.end();
    this.destroyed = true;

    try {
      await endPromise;
    } catch (error) {
      this.destroyed = false;
      throw error;
    }

    this.removeAllListeners();
  }

  /**
   * Internal lifecycle query used by {@link Responder} to avoid directly reading private state.
   * @private
   */
  public isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Internal lifecycle query used by {@link Responder} to drop an advertisement that was withdrawn while it waited for its turn to probe.
   * @private
   */
  public hasAdvertisementIntent(): boolean {
    return this.advertisementIntent;
  }

  /**
   * @returns The fully qualified domain name of the service, used to identify the service. It is in DNS presentation form: a dot or a backslash inside the
   *   service name is escaped with a backslash, so the service named "Mr. Coffee" is "Mr\. Coffee._hap._tcp.local.".
   */
  public getFQDN(): string {
    return this.fqdn;
  }

  /**
   * @returns The service type pointer.
   */
  public getTypePTR(): string {
    return this.typePTR;
  }

  /**
   * @returns Array of subtype pointers (undefined if no subtypes are specified).
   */
  public getLowerCasedSubtypePTRs(): string[] | undefined {
    return this.subTypePTRs;
  }

  /**
   * @returns The current hostname of the service.
   */
  public getHostname(): string {
    return this.hostname;
  }

  /**
   * @returns The port the service is advertising for.
   * {@code -1} is returned when the port is not yet set.
   */
  public getPort(): number {
    return this.port || -1;
  }

  /**
   * @returns The current TXT of the service represented as Buffer array.
   * @private There is not need for this to be public API
   */
  public getTXT(): Buffer[] {
    return this.txt;
  }

  /**
   * @private used for internal comparison {@link dnsLowerCase}
   */
  public getLowerCasedFQDN(): string {
    return this.loweredFqdn;
  }

  /**
   * @private used for internal comparison {@link dnsLowerCase}
   */
  public getLowerCasedTypePTR(): string {
    return this.loweredTypePTR;
  }

  /**
   * @private used for internal comparison {@link dnsLowerCase}
   */
  public getLowerCasedHostname(): string {
    return this.loweredHostname;
  }

  /**
   * Sets or updates the txt of the service.
   *
   * @param {ServiceTxt} txt - The updated txt record.
   * @param {boolean} silent - If set to true no announcement is sent for the updated record.
   */
  public updateTxt(txt: ServiceTxt, silent: boolean = false): void {
    assert(!this.destroyed, "Cannot update destroyed service!");
    assert(txt, "txt cannot be undefined");

    this.txt = CiaoService.txtBuffersFromRecord(txt);
    debug("[%s] Updating txt record%s...", this.name, silent? " silently": "");

    if (this.serviceState === ServiceState.ANNOUNCING) {
      this.rebuildServiceRecords();

      if (silent) {
        return;
      }

      if (this.currentAnnouncer!.hasSentLastAnnouncement()) {
        // if the announcer hasn't sent the last announcement, the above call of rebuildServiceRecords will
        // result in updated records on the next announcement. Otherwise, we still need to announce the updated records
        this.currentAnnouncer!.awaitAnnouncement().then(() => {
          this.queueTxtUpdate();
        }, reason => this.handleAnnouncementWaitFailure(reason));
      }
    } else if (this.serviceState === ServiceState.ANNOUNCED) {
      this.rebuildServiceRecords();

      if (silent) {
        return;
      }

      this.queueTxtUpdate();
    }
  }

  private queueTxtUpdate(): void {
    if (this.txtTimer) {
      return;
    } else {
      // we debounce txt updates, otherwise if api users would spam txt updates, we would receive the txt record
      // while we already update our txt to the next call, thus causing a conflict being detected.
      // We would then continue with Probing (to ensure uniqueness) and could then receive following spammed updates as conflicts,
      // and we would change our name without it being necessary
      this.txtTimer = setTimeout(() => {
        this.txtTimer = undefined;
        if (this.serviceState !== ServiceState.ANNOUNCED) { // stuff changed in the last 50 milliseconds
          return;
        }
        this.emit(InternalServiceEvent.RECORD_UPDATE, {
          answers: [ this.txtRecord() ],
          additionals: [ this.serviceNSECRecord() ],
        });
      }, 50);
      this.txtTimer.unref(); // a pending debounce must not hold the event loop open at shutdown
    }
  }

  /* The rejection handler of an update waiting on the current announcement. A cancelled announcement gave way to whatever cancelled it, and a failed one
   * is handled by the code that started it, so neither leaves the update anything to do, and handling the rejection here keeps it from going unhandled.
   */
  private handleAnnouncementWaitFailure(reason: unknown): void {
    if (reason !== Announcer.CANCEL_REASON) {
      debug("[%s] The announcement an update waited on failed: %s", this.name, reason);
    }
  }

  /**
   * Sets or updates the port of the service.
   * A new port number can only be set when the service is still UNANNOUNCED.
   * Otherwise, an assertion error will be thrown.
   *
   * @param {number} port - The new port number.
   */
  public updatePort(port: number): void {
    assert(this.serviceState === ServiceState.UNANNOUNCED, "Port number cannot be changed when service is already advertised!");
    this.port = port;
  }

  /**
   * This method updates the name of the service.
   * @param name - The new service name.
   * @private Currently not public API and only used for bonjour conformance testing.
   */
  public updateName(name: string): Promise<void> {
    if (this.serviceState === ServiceState.UNANNOUNCED) {
      this.name = name;
      this.fqdn = this.formatFQDN();
      this.loweredFqdn = dnsLowerCase(this.fqdn);
      return Promise.resolve();
    } else {
      return this.end() // send goodbye packets for the current name
        .then(() => {
          this.name = name;
          this.fqdn = this.formatFQDN();
          this.loweredFqdn = dnsLowerCase(this.fqdn);

          // service records are going to be rebuilt on the 'advertise' step
          return this.advertise();
        });
    }
  }

  private static txtBuffersFromRecord(txt: ServiceTxt): Buffer[] {
    const result: Buffer[] = [];

    Object.entries(txt).forEach(([key, value]) => {
      const entry = key + "=" + value;
      result.push(Buffer.from(entry));
    });

    return result;
  }

  /**
   * @param networkUpdate
   * @private
   */
  handleNetworkInterfaceUpdate(networkUpdate: NetworkUpdate): void {
    assert(!this.destroyed, "Cannot update network of destroyed service!");
    // this will currently only be called when service is ANNOUNCED or in ANNOUNCING state

    if (this.serviceState !== ServiceState.ANNOUNCED) {
      if (this.serviceState === ServiceState.ANNOUNCING) {
        this.rebuildServiceRecords();

        if (this.currentAnnouncer!.hasSentLastAnnouncement()) {
          // if the announcer hasn't sent the last announcement, the above call of rebuildServiceRecords will
          // result in updated records on the next announcement. Otherwise, we still need to announce the updated records
          this.currentAnnouncer!.awaitAnnouncement().then(() => {
            this.handleNetworkInterfaceUpdate(networkUpdate);
          }, reason => this.handleAnnouncementWaitFailure(reason));
        }
      }

      return; // service records are rebuilt short before the 'announce' step
    }

    // we don't care about removed interfaces. We can't send goodbye records on a non-existing interface

    this.rebuildServiceRecords();
    // records for a removed interface are now no longer present after the call above
    // records for a new interface got now built by the call above

    if (networkUpdate.added || networkUpdate.changes) {
      // a new network interface got added. We must return into probing state,
      // as we don't know if we still own uniqueness for our service name on the new network.
      // To make things easy and keep the SAME name on all networks, we probe on ALL interfaces.

      // at this moment the new socket won't be bound. Though probing steps are delayed,
      // thus, when sending the first request, the socket will be bound, and we don't need to wait here
      this.emit(InternalServiceEvent.REPUBLISH, error => {
        if (error) {
          console.log("FATAL Error occurred trying to re-announce service " + this.fqdn + "! We can't recover from this!");
          console.log(error.stack);
          process.exit(1); // we have a service which should be announced, though we failed to re-announce.
          // if this should ever happen in reality, whe might want to introduce a more sophisticated recovery
          // for situations where it makes sense
        }
      });
    }
  }

  /**
   * This method is called by the Prober when encountering a conflict on the network.
   * It advises the service to change its name, like incrementing a number appended to the name.
   * So "My Service" will become "My Service (2)", and "My Service (2)" would become "My Service (3)", while the hostname's last label
   * ahead of the domain takes "-(2)", so "My-Service.local." becomes "My-Service-(2).local.". A name or hostname label the number would
   * carry past the 63 octets of a DNS label, or a name past the 255 octets of a DNS name, is cut first, on a character boundary, so a rename
   * can shorten the name. When no prefix fits, the call throws with the service unchanged.
   * The constructor calls it with `nameCheckOnly`, which only aligns the numbers a persisted name and hostname carry and never shortens,
   * so an oversized name is refused there as any other is.
   * @private must only be called by the {@link Prober}
   */
  incrementName(nameCheckOnly?: boolean): void {
    if (this.serviceState !== ServiceState.UNANNOUNCED) {
      throw new Error("Service name can only be incremented when in state UNANNOUNCED!");
    }

    const oldName = this.name;
    const oldHostname = this.hostname;

    let nameBase;
    let nameNumber;

    let hostnameBase;
    let hostnameNumber;

    const nameMatcher = this.name.match(numberedServiceNamePattern);
    if (nameMatcher) { // if it matched. Extract the current nameNumber
      nameBase = nameMatcher[1];
      nameNumber = parseInt(nameMatcher[2]);

      assert(nameNumber, `Failed to extract name number from ${this.name}. Resulted in ${nameNumber}`);
    } else {
      nameBase = this.name;
      nameNumber = 1;
    }

    // The number goes on the hostname's last own label, ahead of the service domain however many labels that holds, read raw so its octets are its own. The
    // own part is split as the end of a name, so a last own label ending in an escaped dot stays one label.
    const ownPart = domainFormatter.removeTLD(this.hostname, this.serviceDomain);
    const ownLabels = splitLabels(ownPart);
    const lastLabel = ownLabels[ownLabels.length - 1];

    const hostnameMatcher = lastLabel.match(numberedHostnameLabelPattern);
    if (hostnameMatcher) { // if it matched. Extract the current nameNumber
      hostnameBase = hostnameMatcher[1];
      hostnameNumber = parseInt(hostnameMatcher[2]);

      assert(hostnameNumber, `Failed to extract hostname number from ${this.hostname}. Resulted in ${hostnameNumber}`);
    } else {
      hostnameBase = lastLabel;
      hostnameNumber = 1;
    }

    if (!nameCheckOnly) {
      // increment the numbers
      nameNumber++;
      hostnameNumber++;
    }

    const newNumber = Math.max(nameNumber, hostnameNumber);
    const nameSuffix = newNumber === 1? "": " (" + newNumber + ")";
    const hostnameSuffix = newNumber === 1? "": "-(" + newNumber + ")";

    /* Only a conflict rename shortens. A label takes at most 63 octets, and the octets the rest of its name takes on the wire, the type, protocol and domain
     * labels after the instance and the hostname's other labels with its domain, bound it further to keep the whole name within 255.
     */
    let name = nameBase + nameSuffix;
    let hostnameLabel = hostnameBase + hostnameSuffix;

    if (!nameCheckOnly) {
      const otherHostnameOctets = wireLength(splitLabels(this.hostname)) - (1 + Buffer.byteLength(lastLabel));

      name = numberedLabel(nameBase, nameSuffix, Math.min(63, 254 - wireLength(splitLabels(this.typePTR))), "The service name '" + this.name + "'");
      hostnameLabel = numberedLabel(hostnameBase, hostnameSuffix, Math.min(63, 254 - otherHostnameOctets), "The hostname '" + this.hostname + "'");
    }

    // Every field is built and checked before any is assigned, so a rename that throws leaves the service as it was.
    const hostname = [ ...ownLabels.slice(0, -1), hostnameLabel ].map(escapeLabel).join(".") + this.hostname.slice(ownPart.length);
    const fqdn = this.formatFQDN(name);

    this.name = name;
    this.hostname = hostname;
    this.loweredHostname = dnsLowerCase(this.hostname);

    this.fqdn = fqdn;
    this.loweredFqdn = dnsLowerCase(this.fqdn);

    // we must inform the user that the names changed, so the new names can be persisted
    // This is done after the Probing finish, as multiple name changes could happen in one probing session
    // It is the responsibility of the Prober to call the informAboutNameUpdates function

    if (this.name !== oldName || this.hostname !== oldHostname) {
      debug("[%s] Service changed name '%s' -> '%s', '%s' -> '%s'", this.name, oldName, this.name, oldHostname, this.hostname);
    }

    if (!nameCheckOnly) {
      this.rebuildServiceRecords(); // rebuild all services
    }
  }

  /**
   * @private called by the Prober once finished with probing to signal a (or more)
   *   name change(s) happened {@see incrementName}.
   */
  informAboutNameUpdates(): void {
    // we trust the prober that this function is only called when the name was actually changed

    const nameCalled = this.emit(ServiceEvent.NAME_CHANGED, this.name);
    const hostnameCalled = this.emit(ServiceEvent.HOSTNAME_CHANGED, domainFormatter.removeTLD(this.hostname, this.serviceDomain));

    // at least one event should be listened to. We can figure out the number from one or another
    if (!nameCalled && !hostnameCalled) {
      console.warn(`CIAO: [${this.name}] Service changed name but nobody was listening on the 'name-change' event!`);
    }
  }

  private formatFQDN(name = this.name): string {
    if (this.serviceState !== ServiceState.UNANNOUNCED) {
      throw new Error("Name can't be changed after service was already announced!");
    }

    const fqdn = domainFormatter.stringify({
      name: name,
      type: this.type,
      protocol: this.protocol,
      domain: this.serviceDomain,
    });

    /* The limits are in octets on the wire, so an escape counts nothing and a multi-byte character counts each of its bytes. The hostname derived from the
     * name swaps a dot or a space, each one octet, for a dash, also one octet, one for one, so the instance check bounds the derived hostname label too.
     */
    const labels = splitLabels(fqdn);
    const instanceOctets = Buffer.byteLength(labels[0]);
    const fqdnOctets = wireLength(labels);

    assert(instanceOctets <= 63, "The service name '" + name + "' takes " + instanceOctets + " octets as an instance label, more than the 63 a DNS label " +
      "may hold.");
    assert(fqdnOctets <= 255, "The name '" + fqdn + "' takes " + fqdnOctets + " octets on the wire, more than the 255 a DNS name may hold.");
    return fqdn;
  }

  /**
   * @private called once the service data/state is updated and the records should be updated with the new data
   */
  rebuildServiceRecords(): void {
    assert(this.port, "port must be set before building records");
    debug("[%s] Rebuilding service records...", this.name);

    const aRecordMap: Record<InterfaceName, ARecord> = {};
    const aaaaRecordMap: Record<InterfaceName, AAAARecord> = {};
    const aaaaRoutableRecordMap: Record<InterfaceName, AAAARecord> = {};
    const aaaaUniqueLocalRecordMap: Record<InterfaceName, AAAARecord> = {};
    const reverseAddressMap: Record<IPAddress, PTRRecord> = {};
    let subtypePTRs: PTRRecord[] | undefined = undefined;

    for (const [name, networkInterface] of this.networkManager.getInterfaceMap()) {
      if (!this.advertisesOnInterface(name, true)) {
        continue;
      }

      let restrictedAddresses: IPAddress[] | undefined = this.restrictedAddresses? this.restrictedAddresses.get(name): undefined;
      if (restrictedAddresses && restrictedAddresses.length === 0) {
        restrictedAddresses = undefined;
      }

      if (networkInterface.ipv4 && (!restrictedAddresses || restrictedAddresses.includes(networkInterface.ipv4))) {
        aRecordMap[name] = new ARecord(this.hostname, networkInterface.ipv4, true);
        reverseAddressMap[networkInterface.ipv4] = new PTRRecord(formatReverseAddressPTRName(networkInterface.ipv4), this.hostname);
      }

      if (networkInterface.ipv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(networkInterface.ipv6))) {
        aaaaRecordMap[name] = new AAAARecord(this.hostname, networkInterface.ipv6, true);
        reverseAddressMap[networkInterface.ipv6] = new PTRRecord(formatReverseAddressPTRName(networkInterface.ipv6), this.hostname);
      }

      if (networkInterface.globallyRoutableIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(networkInterface.globallyRoutableIpv6))) {
        aaaaRoutableRecordMap[name] = new AAAARecord(this.hostname, networkInterface.globallyRoutableIpv6, true);
        reverseAddressMap[networkInterface.globallyRoutableIpv6] = new PTRRecord(formatReverseAddressPTRName(networkInterface.globallyRoutableIpv6), this.hostname);
      }

      if (networkInterface.uniqueLocalIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(networkInterface.uniqueLocalIpv6))) {
        aaaaUniqueLocalRecordMap[name] = new AAAARecord(this.hostname, networkInterface.uniqueLocalIpv6, true);
        reverseAddressMap[networkInterface.uniqueLocalIpv6] = new PTRRecord(formatReverseAddressPTRName(networkInterface.uniqueLocalIpv6), this.hostname);
      }
    }

    if (this.subTypePTRs) {
      subtypePTRs = [];
      for (const ptr of this.subTypePTRs) {
        subtypePTRs.push(new PTRRecord(ptr, this.fqdn));
      }
    }

    this.serviceRecords = {
      ptr: new PTRRecord(this.typePTR, this.fqdn),
      subtypePTRs: subtypePTRs, // possibly undefined
      metaQueryPtr: new PTRRecord(SERVICE_TYPE_ENUMERATION_NAME, this.typePTR),

      srv: new SRVRecord(this.fqdn, this.hostname, this.port!, true),
      txt: new TXTRecord(this.fqdn, this.txt, true),
      serviceNSEC: new NSECRecord(this.fqdn, this.fqdn, [RType.TXT, RType.SRV], 4500, true), // 4500 ttl of src and txt

      a: aRecordMap,
      aaaa: aaaaRecordMap,
      aaaaR: aaaaRoutableRecordMap,
      aaaaULA: aaaaUniqueLocalRecordMap,
      reverseAddressPTRs: reverseAddressMap,
    };
  }

  /**
   * Returns if the given service is advertising on the provided network interface.
   *
   * @param name - The desired interface name. The name of an interface's IPv6 socket ("en0/6") is accepted as well.
   * @param skipAddressCheck - If true it is not checked if the service actually has
   *   an address record for the given interface.
   * @private returns if the service should be advertised on the given service
   */
  advertisesOnInterface(name: InterfaceName, skipAddressCheck?: boolean): boolean {
    // the MDNSServer names an interface's IPv6 socket "<name>/6", while restrictedAddresses and the
    // address records are keyed by the interface's own name
    const interfaceName = name.endsWith("/6") ? name.slice(0, -2) : name;
    return !this.restrictedAddresses || this.restrictedAddresses.has(interfaceName) && (
      skipAddressCheck ||
      // must have at least one address record on the given interface
      !!this.serviceRecords?.a[interfaceName] || !!this.serviceRecords?.aaaa[interfaceName]
      || !!this.serviceRecords?.aaaaR[interfaceName] || !!this.serviceRecords?.aaaaULA[interfaceName]
    );
  }

  /**
   * @private used to get a copy of the main PTR record
   */
  ptrRecord(): PTRRecord {
    return this.serviceRecords!.ptr.clone();
  }

  /**
   * @private used to get a copy of the array of subtype PTR records
   */
  subtypePtrRecords(): PTRRecord[] {
    return this.serviceRecords!.subtypePTRs? ResourceRecord.clone(this.serviceRecords!.subtypePTRs): [];
  }

  /**
   * @private used to get a copy of the meta-query PTR record
   */
  metaQueryPtrRecord(): PTRRecord {
    return this.serviceRecords!.metaQueryPtr.clone();
  }

  /**
   * @private used to get a copy of the SRV record
   */
  srvRecord(): SRVRecord {
    return this.serviceRecords!.srv.clone();
  }

  /**
   * @private used to get a copy of the TXT record
   */
  txtRecord(): TXTRecord {
    return this.serviceRecords!.txt.clone();
  }

  /**
   * @private used to get a copy of the A record
   */
  aRecord(name: InterfaceName): ARecord | undefined {
    const record = this.serviceRecords!.a[name];
    return record? record.clone(): undefined;
  }

  /**
   * @private used to get a copy of the AAAA record for the link-local ipv6 address
   */
  aaaaRecord(name: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords!.aaaa[name];
    return record? record.clone(): undefined;
  }

  /**
   * @private used to get a copy of the AAAA record for the routable ipv6 address
   */
  aaaaRoutableRecord(name: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords!.aaaaR[name];
    return record? record.clone(): undefined;
  }

  /**
   * @private used to get a copy of the AAAA for the unique local ipv6 address
   */
  aaaaUniqueLocalRecord(name: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords!.aaaaULA[name];
    return record? record.clone(): undefined;
  }

  /**
   * @private used to get a copy of the A and AAAA records
   */
  allAddressRecords(): (ARecord | AAAARecord)[] {
    const records: (ARecord | AAAARecord)[] = [];

    Object.values(this.serviceRecords!.a).forEach(record => {
      records.push(record.clone());
    });
    Object.values(this.serviceRecords!.aaaa).forEach(record => {
      records.push(record.clone());
    });
    Object.values(this.serviceRecords!.aaaaR).forEach(record => {
      records.push(record.clone());
    });
    Object.values(this.serviceRecords!.aaaaULA).forEach(record => {
      records.push(record.clone());
    });

    return records;
  }

  /**
   * @param other - Another service of the same responder.
   * @private returns if both services publish exactly the same address records, which is what lets
   *   them share a hostname. Two services restricted to different addresses would each keep
   *   overwriting the other's address records for it.
   */
  sharesAddressRecordsWith(other: CiaoService): boolean {
    if (!!this.disableIpv6 !== !!other.disableIpv6) {
      return false;
    }

    if (!this.restrictedAddresses || !other.restrictedAddresses) {
      return !this.restrictedAddresses && !other.restrictedAddresses;
    }

    if (this.restrictedAddresses.size !== other.restrictedAddresses.size) {
      return false;
    }

    for (const [name, addresses] of this.restrictedAddresses) {
      const otherAddresses = other.restrictedAddresses.get(name);
      if (!otherAddresses || otherAddresses.length !== addresses.length
        || !addresses.every(address => otherAddresses.includes(address))) {
        return false;
      }
    }

    return true;
  }

  /**
   * @param name - The interface's own name, which the address records are keyed by.
   * @private used to get the address NSEC record of an interface, or undefined for an interface on which the service holds no address record. Its bitmap
   *   lists exactly the address types the service holds records of there: A for its A record, and AAAA for any of its link-local, routable and unique
   *   local AAAA records. A type listed without a record keeps a querier waiting for one that never comes (RFC 6762 6.1), so the bitmap is built from the
   *   interface's records each time it is asked for, and no stored bitmap can outlive a network change.
   */
  addressNSECRecord(name: InterfaceName): NSECRecord | undefined {
    const records = this.serviceRecords!;
    const types: RType[] = [];

    if (records.a[name]) {
      types.push(RType.A);
    }

    if (records.aaaa[name] || records.aaaaR[name] || records.aaaaULA[name]) {
      types.push(RType.AAAA);
    }

    // The NSEC takes the TTL of the address records whose existence it asserts (RFC 6762 6.1).
    return types.length? new NSECRecord(this.hostname, this.hostname, types, ARecord.DEFAULT_TTL, true): undefined;
  }

  /**
   * @private user to get a copy of the service NSEC record
   */
  serviceNSECRecord(shortenTTL = false): NSECRecord {
    const record = this.serviceRecords!.serviceNSEC.clone();
    if (shortenTTL) {
      record.ttl = 120;
    }
    return record;
  }

  /**
   * @param address - The IP address to check.
   * @private used to check if given address is exposed by this service
   */
  hasAddress(address: IPAddress): boolean {
    return !!this.serviceRecords!.reverseAddressPTRs[address];
  }
  /*
  reverseAddressMapping(address: string): PTRRecord | undefined {
    const record = this.serviceRecords.reverseAddressPTRs[address];
    return record? record.clone(): undefined;
  }

  reverseAddressMappings(networkInterface: NetworkInterface): PTRRecord[] {
    const records: PTRRecord[] = [];

    if (networkInterface.ipv4) {
      const reverseRecord = this.serviceRecords.reverseAddressPTRs[networkInterface.ipv4];
      if (reverseRecord) {
        records.push(reverseRecord.clone());
      }
    }

    if (networkInterface.ipv6) {
      const reverseRecord = this.serviceRecords.reverseAddressPTRs[networkInterface.ipv6];
      if (reverseRecord) {
        records.push(reverseRecord.clone());
      }
    }
    if (networkInterface.globallyRoutableIpv6) {
      const reverseRecord = this.serviceRecords.reverseAddressPTRs[networkInterface.globallyRoutableIpv6];
      if (reverseRecord) {
        records.push(reverseRecord.clone());
      }
    }

    return records;
  }

  allReverseAddressMappings(): PTRRecord[] {
    return ResourceRecord.clone(Object.values(this.serviceRecords.reverseAddressPTRs));
  }
  */

}
