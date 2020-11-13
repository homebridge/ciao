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
import { Protocol, Responder } from "./index";
import { InterfaceName, IPAddress, NetworkManager, NetworkUpdate } from "./NetworkManager";
import { Announcer } from "./responder/Announcer";
import { dnsLowerCase } from "./util/dns-equal";
import * as domainFormatter from "./util/domain-formatter";
import { formatReverseAddressPTRName } from "./util/domain-formatter";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:CiaoService");

const numberedServiceNamePattern = /^(.*) \((\d+)\)$/; // matches a name lik "My Service (2)"
const numberedHostnamePattern = /^(.*)-\((\d+)\)(\.\w{2,}.)$/; // matches a hostname like "My-Computer-(2).local."

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
   * If not supplied it must be set later via {@link updatePort} BEFORE advertising the service.
   */
  port?: number;

  /**
   * The protocol the service uses. Default is TCP.
   */
  protocol?: Protocol;
  /**
   * Defines a hostname under which the service can be reached.
   * The specified hostname must not include the TLD.
   * If undefined the service name will be used as default.
   */
  hostname?: string;
  /**
   * If defined, a txt record will be published with the given service.
   */
  txt?: ServiceTxt;

  /**
   * Adds ability to set custom domain. Will default to "local".
   * The domain will also be automatically appended to the hostname.
   */
  domain?: string;

  /**
   * If defined it restricts the service to be advertised on the specified
   * ip addresses or interface names.
   *
   * If a interface name is specified, ANY address on that given interface will be advertised
   * (if a IP address of the given interface is also given in the array, it will be overridden).
   * If a IP address is specified, the service will only be advertised for the given addresses.
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
 * @priavte
 */
export const enum ServiceState {
  UNANNOUNCED = "unannounced",
  PROBING = "probing",
  PROBED = "probed", // service was probed to be unique
  ANNOUNCING = "announcing", // service is in the process of being announced
  ANNOUNCED = "announced",
}

/**
 * @priavte
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
  addressNSEC: NSECRecord;
}

/**
 * Events thrown by a CiaoService
 */
export const enum ServiceEvent {
  /**
   * Event is called when the Prober identifies that the name for the service is already used
   * and thus resolve the name conflict by adjusting the name (e.g. adding '(2)' to the name).
   * This change must be persisted and thus a listener must hook up to this event
   * in order for the name to be persisted.
   */
  NAME_CHANGED = "name-change",
  /**
   * Event is called when the Prober identifies that the hostname for the service is already used
   * and thus resolve the name conflict by adjusting the hostname (e.g. adding '(2)' to the hostname).
   * The name change must be persisted. As the hostname is an optional parameter, it is derived
   * from the service name if not supplied.
   * If you supply a custom hostname (not automatically derived from the service name) you must
   * hook up a listener to this event in order for the hostname to be persisted.
   */
  HOSTNAME_CHANGED = "hostname-change",
}

/**
 * Events thrown by a CiaoService, internal use only!
 * @priavte
 */
export const enum InternalServiceEvent {
  PUBLISH = "publish",
  UNPUBLISH = "unpublish",
  REPUBLISH = "republish",
  RECORD_UPDATE = "records-update",
  RECORD_UPDATE_ON_INTERFACE = "records-update-interface",
}

/**
 * @priavte
 */
export type PublishCallback = (error?: Error) => void;
/**
 * @priavte
 */
export type UnpublishCallback = (error?: Error) => void;
/**
 * @priavte
 */
export type RecordsUpdateCallback = (error?: Error | null) => void;

export declare interface CiaoService {

  on(event: "name-change", listener: (name: string) => void): this;
  on(event: "hostname-change", listener: (hostname: string) => void): this;

  /**
   * @priavte
   */
  on(event: InternalServiceEvent.PUBLISH, listener: (callback: PublishCallback) => void): this;
  /**
   * @priavte
   */
  on(event: InternalServiceEvent.UNPUBLISH, listener: (callback: UnpublishCallback) => void): this;
  /**
   * @priavte
   */
  on(event: InternalServiceEvent.REPUBLISH, listener: (callback: PublishCallback) => void): this;
  /**
   * @priavte
   */
  on(event: InternalServiceEvent.RECORD_UPDATE, listener: (response: DNSResponseDefinition, callback?: (error?: Error | null) => void) => void): this;
  /**
   * @priavte
   */
  on(event: InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, listener: (name: InterfaceName, records: ResourceRecord[], callback?: RecordsUpdateCallback) => void): this;

  /**
   * @priavte
   */
  emit(event: ServiceEvent.NAME_CHANGED, name: string): boolean;
  /**
   * @priavte
   */
  emit(event: ServiceEvent.HOSTNAME_CHANGED, hostname: string): boolean;

  /**
   * @priavte
   */
  emit(event: InternalServiceEvent.PUBLISH, callback: PublishCallback): boolean;
  /**
   * @priavte
   */
  emit(event: InternalServiceEvent.UNPUBLISH, callback: UnpublishCallback): boolean;
  /**
   * @priavte
   */
  emit(event: InternalServiceEvent.REPUBLISH, callback?: PublishCallback): boolean;
  /**
   * @priavte
   */
  emit(event: InternalServiceEvent.RECORD_UPDATE, response: DNSResponseDefinition, callback?: (error?: Error | null) => void): boolean;
  /**
   * @priavte
   */
  emit(event: InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, name: InterfaceName, records: ResourceRecord[], callback?: RecordsUpdateCallback): boolean;

}

/**
 * The CiaoService class represents a service which can be advertised on the network.
 *
 * A service is identified by it's fully qualified domain name (FQDN), which consist of
 * the service name, the service type, the protocol and the service domain (.local by default).
 *
 * The service defines a hostname and a port where the advertised service can be reached.
 *
 * Additionally a TXT record can be published, which can contain information (in form of key-value pairs),
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
   * @priavte use by the Responder to set the current service state
   */
  serviceState = ServiceState.UNANNOUNCED;
  /**
   * If service is in state {@link ServiceState.ANNOUNCING} the {@link Announcer} responsible for the
   * service will be linked here. This is need to cancel announcing when for example the service
   * should be terminated and we sill aren't fully announced yet.
   * @priavte is controlled by the {@link Responder} instance
   */
  currentAnnouncer?: Announcer;
  private serviceRecords?: ServiceRecords;

  private destroyed = false;

  /**
   * Constructs a new service. Please use {@link Responder.createService} to create new service.
   * When calling the constructor a callee must listen to certain events in order to provide
   * correct functionality.
   * @priavte used by the Responder instance to create a new service
   */
  constructor(networkManager: NetworkManager, options: ServiceOptions) {
    super();
    assert(networkManager, "networkManager is required");
    assert(options, "parameters options is required");
    assert(options.name, "service options parameter 'name' is required");
    assert(options.type, "service options parameter 'type' is required");
    assert(options.type.length <= 15, "service options parameter 'type' must not be longer than 15 characters");

    this.networkManager = networkManager;

    this.name = options.name;
    this.type = options.type;
    this.subTypes = options.subtypes;
    this.protocol = options.protocol || Protocol.TCP;
    this.serviceDomain = options.domain || "local";

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

    this.hostname = domainFormatter.formatHostname(options.hostname || this.name, this.serviceDomain)
      .replace(/ /g, "-"); // replacing all spaces with dashes in the hostname
    this.loweredHostname = dnsLowerCase(this.hostname);
    this.port = options.port;

    if (options.restrictedAddresses) {
      assert(options.restrictedAddresses, "The service property 'restrictedAddresses' cannot be an empty array!");
      this.restrictedAddresses = new Map();

      for (const entry of options.restrictedAddresses) {
        if (net.isIP(entry)) {
          if (entry === "0.0.0.0" || entry === "::") {
            throw new Error(`[${this.fqdn}] Unspecified ip address (${entry}) cannot be used to restrict on to!`);
          }

          const interfaceName = NetworkManager.resolveInterface(entry);
          if (!interfaceName) {
            throw new Error(`[${this.fqdn}] Could not restrict service to address ${entry} as we could not resolve it to an interface name!`);
          }

          const current = this.restrictedAddresses.get(interfaceName);
          if (current) {
            // empty interface signals "catch all" was already configured for this
            if (current.length && !current.includes(entry)) {
              current.push(entry);
            }
          } else {
            this.restrictedAddresses.set(interfaceName, [entry]);
          }
        } else {
          this.restrictedAddresses.set(entry, []); // empty array signals "use all addresses for interface"
        }
      }
    }
    this.disableIpv6 = options.disabledIpv6;

    this.txt = options.txt? CiaoService.txtBuffersFromRecord(options.txt): [];

    // checks if hostname or name are already numbered and adjusts the numbers if necessary
    this.incrementName(true);
  }

  /**
   * This method start the advertising process of the service:
   *  - The service name (and hostname) will be probed unique on all interfaces (as defined in RFC 6762 8.1).
   *  - Once probed unique the service will be announced (as defined in RFC 6762 8.3).
   *
   *  The returned promise resolves once the last announcement packet was successfully sent on all network interfaces.
   *  The promise might be rejected caused by one of the following reasons:
   *    - A probe query could not be sent successfully
   *    - Prober could not find a unique service name while trying for a minute (timeout)
   *    - One of the announcement packets could not be sent successfully
   */
  public advertise(): Promise<void> {
    assert(!this.destroyed, "Cannot publish destroyed service!");
    assert(this.port, "Service port must be defined before advertising the service on the network!");

    if (this.listeners(ServiceEvent.NAME_CHANGED).length === 0) {
      debug("[%s] WARN: No listeners found for a potential name change on the 'name-change' event!", this.name);
    }
    return new Promise((resolve, reject) => {
      this.emit(InternalServiceEvent.PUBLISH, error => error? reject(error): resolve());
    });
  }

  /**
   * This method will remove the advertisement for the service on all connected network interfaces.
   * If the service is still in the Probing state, probing will simply be cancelled.
   *
   * @returns Promise will resolve once the last goodbye packet was sent out
   */
  public end(): Promise<void> {
    assert(!this.destroyed, "Cannot end destroyed service!");
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
    await this.end();

    this.destroyed = true;
    this.removeAllListeners();
  }

  /**
   * @returns The fully qualified domain name of the service, used to identify the service.
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
   * @priavte There is not need for this to be public API
   */
  public getTXT(): Buffer[] {
    return this.txt;
  }

  /**
   * @priavte used for internal comparison {@link dnsLowerCase}
   */
  public getLowerCasedFQDN(): string {
    return this.loweredFqdn;
  }

  /**
   * @priavte used for internal comparison {@link dnsLowerCase}
   */
  public getLowerCasedTypePTR(): string {
    return this.loweredTypePTR;
  }

  /**
   * @priavte used for internal comparison {@link dnsLowerCase}
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
  public updateTxt(txt: ServiceTxt, silent = false): void {
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
        // result in updated records on the next announcement. Otherwise we still need to announce the updated records
        this.currentAnnouncer!.awaitAnnouncement().then(() => {
          this.queueTxtUpdate();
        });
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
      // We would then continue with Probing (to ensure uniqueness) and could then receive following spammed updates as conflicts
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
    }
  }

  /**
   * Sets or updates the port of the service.
   * A new port number can only be set when the service is still UNANNOUNCED.
   * Otherwise an assertion error will be thrown.
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
   * @priavte Currently not public API and only used for bonjour conformance testing.
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

          // service records are going to be rebuilt on the advertise step
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
   * @priavte
   */
  handleNetworkInterfaceUpdate(networkUpdate: NetworkUpdate): void {
    assert(!this.destroyed, "Cannot update network of destroyed service!");
    // this will currently only be called when service is ANNOUNCED or in ANNOUNCING state

    if (this.serviceState !== ServiceState.ANNOUNCED) {
      if (this.serviceState === ServiceState.ANNOUNCING) {
        this.rebuildServiceRecords();

        if (this.currentAnnouncer!.hasSentLastAnnouncement()) {
          // if the announcer hasn't sent the last announcement, the above call of rebuildServiceRecords will
          // result in updated records on the next announcement. Otherwise we still need to announce the updated records
          this.currentAnnouncer!.awaitAnnouncement().then(() => {
            this.handleNetworkInterfaceUpdate(networkUpdate);
          });
        }
      }

      return; // service records are rebuilt short before the announce step
    }

    // we don't care about removed interfaces. We can't sent goodbye records on a non existing interface

    this.rebuildServiceRecords();
    // records for a removed interface are now no longer present after the call above
    // records for a new interface got now built by the call above

    /* logic disabled for now
    if (networkUpdate.changes) {
      // we could optimize this and don't send the announcement of records if we have also added a new interface
      // Though probing will take at least 750 ms and thus sending it out immediately will get the information out faster.

      for (const change of networkUpdate.changes) {
        if (!this.advertisesOnInterface(change.name, true)) {
          continue;
        }

        let restrictedAddresses: IPAddress[] | undefined = this.restrictedAddresses? this.restrictedAddresses.get(change.name): undefined;
        if (restrictedAddresses && restrictedAddresses.length === 0) {
          restrictedAddresses = undefined;
        }
        const records: ResourceRecord[] = [];

        if (change.outdatedIpv4 && (!restrictedAddresses || restrictedAddresses.includes(change.outdatedIpv4))) {
          records.push(new ARecord(this.hostname, change.outdatedIpv4, true, 0));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedIpv4), this.hostname, false, 0));
        }
        if (change.outdatedIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(change.outdatedIpv6))) {
          records.push(new AAAARecord(this.hostname, change.outdatedIpv6, true, 0));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedIpv6), this.hostname, false, 0));
        }
        if (change.outdatedGloballyRoutableIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(change.outdatedGloballyRoutableIpv6))) {
          records.push(new AAAARecord(this.hostname, change.outdatedGloballyRoutableIpv6, true, 0));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedGloballyRoutableIpv6), this.hostname, false, 0));
        }
        if (change.outdatedUniqueLocalIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(change.outdatedUniqueLocalIpv6))) {
          records.push(new AAAARecord(this.hostname, change.outdatedUniqueLocalIpv6, true, 0));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedUniqueLocalIpv6), this.hostname, false, 0));
        }

        if (change.updatedIpv4 && (!restrictedAddresses || restrictedAddresses.includes(change.updatedIpv4))) {
          records.push(new ARecord(this.hostname, change.updatedIpv4, true));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedIpv4), this.hostname));
        }
        if (change.updatedIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(change.updatedIpv6))) {
          records.push(new AAAARecord(this.hostname, change.updatedIpv6, true));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedIpv6), this.hostname));
        }
        if (change.updatedGloballyRoutableIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(change.updatedGloballyRoutableIpv6))) {
          records.push(new AAAARecord(this.hostname, change.updatedGloballyRoutableIpv6, true));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedGloballyRoutableIpv6), this.hostname));
        }
        if (change.updatedUniqueLocalIpv6 && !this.disableIpv6 && (!restrictedAddresses || restrictedAddresses.includes(change.updatedUniqueLocalIpv6))) {
          records.push(new AAAARecord(this.hostname, change.updatedUniqueLocalIpv6, true));
          // records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedUniqueLocalIpv6), this.hostname));
        }

        this.emit(InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, change.name, records);
      }
    }
    */

    if (networkUpdate.added || networkUpdate.changes) {
      // a new network interface got added. We must return into probing state,
      // as we don't know if we still own uniqueness for our service name on the new network.
      // To make things easy and keep the SAME name on all networks, we probe on ALL interfaces.

      // in this moment the new socket won't be bound. Though probing steps are delayed,
      // thus, when sending the first request, the socket will be bound and we don't need to wait here
      this.emit(InternalServiceEvent.REPUBLISH, error => {
        if (error) {
          console.log("FATAL Error occurred trying to reannounce service " + this.fqdn + "! We can't recover from this!");
          console.log(error.stack);
          process.exit(1); // we have a service which should be announced, though we failed to reannounce.
          // if this should ever happen in reality, whe might want to introduce a more sophisticated recovery
          // for situations where it makes sense
        }
      });
    }
  }

  /**
   * This method is called by the Prober when encountering a conflict on the network.
   * It advices the service to change its name, like incrementing a number appended to the name.
   * So "My Service" will become "My Service (2)", and "My Service (2)" would become "My Service (3)"
   * @priavte must only be called by the {@link Prober}
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
    let hostnameTLD;
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

    const hostnameMatcher = this.hostname.match(numberedHostnamePattern);
    if (hostnameMatcher) { // if it matched. Extract the current nameNumber
      hostnameBase = hostnameMatcher[1];
      hostnameTLD = hostnameMatcher[3];
      hostnameNumber = parseInt(hostnameMatcher[2]);

      assert(hostnameNumber, `Failed to extract hostname number from ${this.hostname}. Resulted in ${hostnameNumber}`);
    } else {
      // we need to substring, to not match the root label "."
      const lastDot = this.hostname.substring(0, this.hostname.length - 1).lastIndexOf(".");

      hostnameBase = this.hostname.slice(0, lastDot);
      hostnameTLD = this.hostname.slice(lastDot);
      hostnameNumber = 1;
    }

    if (!nameCheckOnly) {
      // increment the numbers
      nameNumber++;
      hostnameNumber++;
    }

    const newNumber = Math.max(nameNumber, hostnameNumber);

    // reassemble the name
    this.name = newNumber === 1? nameBase: `${nameBase} (${newNumber})`;
    this.hostname = newNumber === 1? `${hostnameBase}${hostnameTLD}`: `${hostnameBase}-(${newNumber})${hostnameTLD}`;
    this.loweredHostname = dnsLowerCase(this.hostname);

    this.fqdn = this.formatFQDN(); // update the fqdn
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
   * @priavte called by the Prober once finished with probing to signal a (or more)
   *   name change(s) happened {@see incrementName}.
   */
  informAboutNameUpdates(): void {
    // we trust the prober that this function is only called when the name was actually changed

    const nameCalled = this.emit(ServiceEvent.NAME_CHANGED, this.name);
    const hostnameCalled = this.emit(ServiceEvent.HOSTNAME_CHANGED, domainFormatter.removeTLD(this.hostname));

    // at least one event should be listened to. We can figure out the number from one or another
    if (!nameCalled && !hostnameCalled) {
      console.warn(`CIAO: [${this.name}] Service changed name but nobody was listening on the 'name-change' event!`);
    }
  }

  private formatFQDN(): string {
    if (this.serviceState !== ServiceState.UNANNOUNCED) {
      throw new Error("Name can't be changed after service was already announced!");
    }

    const fqdn = domainFormatter.stringify({
      name: this.name,
      type: this.type,
      protocol: this.protocol,
      domain: this.serviceDomain,
    });

    assert(fqdn.length <= 255, "A fully qualified domain name cannot be longer than 255 characters");
    return fqdn;
  }

  /**
   * @priavte called once the service data/state is updated and the records should be updated with the new data
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
      metaQueryPtr: new PTRRecord(Responder.SERVICE_TYPE_ENUMERATION_NAME, this.typePTR),

      srv: new SRVRecord(this.fqdn, this.hostname, this.port!, true),
      txt: new TXTRecord(this.fqdn, this.txt, true),
      serviceNSEC: new NSECRecord(this.fqdn, this.fqdn, [RType.TXT, RType.SRV], 4500, true), // 4500 ttl of src and txt

      a: aRecordMap,
      aaaa: aaaaRecordMap,
      aaaaR: aaaaRoutableRecordMap,
      aaaaULA: aaaaUniqueLocalRecordMap,
      reverseAddressPTRs: reverseAddressMap,
      addressNSEC: new NSECRecord(this.hostname, this.hostname, [RType.A, RType.AAAA], 120, true), // 120 TTL of A and AAAA records
    };
  }

  /**
   * Returns if the given service is advertising on the provided network interface.
   *
   * @param name - The desired interface name.
   * @param skipAddressCheck - If true it is not checked if the service actually has
   *   an address record for the given interface.
   * @priavte returns if the service should be advertised on the given service
   */
  advertisesOnInterface(name: InterfaceName, skipAddressCheck?: boolean): boolean {
    return !this.restrictedAddresses || this.restrictedAddresses.has(name) && (
      skipAddressCheck ||
      // must have at least one address record on the given interface
      !!this.serviceRecords?.a[name] || !!this.serviceRecords?.aaaa[name]
      || !!this.serviceRecords?.aaaaR[name] || !!this.serviceRecords?.aaaaULA[name]
    );
  }

  /**
   * @priavte used to get a copy of the main PTR record
   */
  ptrRecord(): PTRRecord {
    return this.serviceRecords!.ptr.clone();
  }

  /**
   * @priavte used to get a copy of the array of sub-type PTR records
   */
  subtypePtrRecords(): PTRRecord[] {
    return this.serviceRecords!.subtypePTRs? ResourceRecord.clone(this.serviceRecords!.subtypePTRs): [];
  }

  /**
   * @priavte used to get a copy of the meta-query PTR record
   */
  metaQueryPtrRecord(): PTRRecord {
    return this.serviceRecords!.metaQueryPtr.clone();
  }

  /**
   * @priavte used to get a copy of the SRV record
   */
  srvRecord(): SRVRecord {
    return this.serviceRecords!.srv.clone();
  }

  /**
   * @priavte used to get a copy of the TXT record
   */
  txtRecord(): TXTRecord {
    return this.serviceRecords!.txt.clone();
  }

  /**
   * @priavte used to get a copy of the A record
   */
  aRecord(name: InterfaceName): ARecord | undefined {
    const record = this.serviceRecords!.a[name];
    return record? record.clone(): undefined;
  }

  /**
   * @priavte used to get a copy of the AAAA record for the link-local ipv6 address
   */
  aaaaRecord(name: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords!.aaaa[name];
    return record? record.clone(): undefined;
  }

  /**
   * @priavte used to get a copy of the AAAA record for the routable ipv6 address
   */
  aaaaRoutableRecord(name: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords!.aaaaR[name];
    return record? record.clone(): undefined;
  }

  /**
   * @priavte used to get a copy of the AAAA fore the unique local ipv6 address
   */
  aaaaUniqueLocalRecord(name: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords!.aaaaULA[name];
    return record? record.clone(): undefined;
  }

  /**
   * @priavte used to get a copy of the A and AAAA records
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
   * @priavte used to get a copy of the address NSEC record
   */
  addressNSECRecord(): NSECRecord {
    return this.serviceRecords!.addressNSEC.clone();
  }

  /**
   * @priavte user to get a copy of the service NSEC record
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
   * @priavte used to check if given address is exposed by this service
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
