import {
  AAAARecord,
  AnswerRecord,
  ARecord,
  PTRRecord,
  RecordBase,
  SRVRecord,
  TXTRecord,
  Type,
} from "@homebridge/dns-packet";
import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import net from "net";
import { Protocol, Responder } from "./index";
import { NetworkUpdate, NetworkManager, NetworkManagerEvent, NetworkId, IPAddress } from "./NetworkManager";
import * as domainFormatter from "./util/domain-formatter";
import { formatReverseAddressPTRName } from "./util/domain-formatter";

const debug = createDebug("ciao:CiaoService");

const numberedServiceNamePattern = /^(.*) \((\d+)\)$/; // matches a name lik "My Service (2)"
const numberedHostnamePattern = /^(.*)-(\d+)\((\.\w{2,})\)$/; // matches a hostname like "My-Computer-(2).local"

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

export interface ServiceOptions {
  /**
   * Instance Name of the service
   */
  name: string;
  /**
   * Type of the service
   */
  type: ServiceType | string;
  /**
   * Optional array of subtypes of the service
   */
  subtypes?: (ServiceType | string)[];
  /**
   * Port of the service
   */
  port: number;

  /**
   * The protocol the service uses. Default is TCP.
   */
  protocol?: Protocol;
  /**
   * Defines a hostname under which the service can be reached.
   * The specified hostname should not include the TLD.
   * If undefined the service name will be used as default.
   */
  hostname?: string;
  /**
   * If defined a txt record will be published with the given service.
   */
  txt?: ServiceTxt;

  /**
   * Adds ability to set custom domain. Will default to "local".
   * The domain will also be automatically appended to the hostname.
   */
  domain?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceTxt = Record<string, any>;

export const enum ServiceState {
  UNANNOUNCED = "unannounced",
  PROBING = "probing",
  ANNOUNCED = "announced",
}

export interface ServiceRecords {
  ptr: PTRRecord; // this is the main type ptr record
  subtypePTRs?: PTRRecord[];
  metaQueryPtr: PTRRecord; // pointer for the "_services._dns-sd._udp.local" meta query
  srv: SRVRecord;
  txt: TXTRecord;
  a: Record<NetworkId, ARecord[]>;
  aaaa: Record<NetworkId, AAAARecord[]>;
  reverseAddressPTRs: Record<IPAddress, PTRRecord>; // indexed by address
}

export const enum ServiceEvent {
  /**
   * Event is called when the Prober identifies that the name for the service is already used
   * and thus resolve the name conflict by adjusting the name (e.g. adding '(2)' to the name).
   * This change must be persisted and thus a listener must hook up to this event
   * in order for the name to be persisted.
   */
  NAME_CHANGED = "name-change",
  HOSTNAME_CHANGED = "hostname-change",
}

export const enum InternalServiceEvent {
  PUBLISH = "publish",
  UNPUBLISH = "unpublish",
  RECORD_UPDATE = "records-update",
}

export type PublishCallback = (error?: Error) => void;
export type UnpublishCallback = (error?: Error) => void;

export declare interface CiaoService {

  on(event: "name-change", listener: (name: string) => void): this;
  on(event: "hostname-change", listener: (hostname: string) => void): this;

  on(event: InternalServiceEvent.PUBLISH, listener: (callback: PublishCallback) => void): this;
  on(event: InternalServiceEvent.UNPUBLISH, listener: (callback: UnpublishCallback) => void): this;
  on(event: InternalServiceEvent.RECORD_UPDATE, listener: (records: AnswerRecord[], callback?: (error?: Error | null) => void) => void): this;

  emit(event: ServiceEvent.NAME_CHANGED, name: string): boolean;
  emit(event: ServiceEvent.HOSTNAME_CHANGED, hostname: string): boolean;

  emit(event: InternalServiceEvent.PUBLISH, callback: PublishCallback): boolean;
  emit(event: InternalServiceEvent.UNPUBLISH, callback: UnpublishCallback): boolean;
  emit(event: InternalServiceEvent.RECORD_UPDATE, records: AnswerRecord[], callback?: (error?: Error | null) => void): boolean;

}

export class CiaoService extends EventEmitter {

  private readonly networkManager: NetworkManager;

  private name: string;
  private readonly type: ServiceType | string;
  private readonly subTypes?: string[];
  private readonly protocol: Protocol;
  private readonly serviceDomain: string; // remember: can't be named "domain" => conflicts with EventEmitter

  private fqdn: string; // fully qualified domain name
  private readonly typePTR: string;
  private readonly subTypePTRs?: string[];

  private hostname: string; // formatted hostname
  readonly port: number;

  private txt?: Buffer[];

  serviceState = ServiceState.UNANNOUNCED; // this field is entirely controlled by the Responder class
  private serviceRecords: ServiceRecords;

  constructor(networkManager: NetworkManager, options: ServiceOptions) {
    super();
    assert(networkManager, "networkManager is required");
    assert(options, "parameters options is required");
    assert(options.name, "service options parameter 'name' is required");
    assert(options.type, "service options parameter 'type' is required");
    assert(options.port, "service options parameter 'port' is required");
    assert(options.type.length <= 15, "service options parameter 'type' must not be longer than 15 characters");

    this.networkManager = networkManager;
    this.networkManager.on(NetworkManagerEvent.NETWORK_UPDATE, this.handleNetworkChange.bind(this));

    this.name = options.name;
    this.type = options.type;
    this.subTypes = options.subtypes;
    this.protocol = options.protocol || Protocol.TCP;
    this.serviceDomain = options.domain || "local";

    this.fqdn = this.formatFQDN();

    this.typePTR = domainFormatter.stringify({ // something like '_hap._tcp.local'
      type: this.type,
      protocol: this.protocol,
      domain: this.serviceDomain,
    });

    if (this.subTypes) {
      this.subTypePTRs = this.subTypes.map(subtype => domainFormatter.stringify({
        subtype: subtype,
        type: this.type,
        protocol: this.protocol,
        domain: this.serviceDomain,
      }));
    }

    this.hostname = domainFormatter.formatHostname(options.hostname || this.name, this.serviceDomain)
      .replace(/ /g, "-"); // replacing all spaces with dashes in the hostname
    this.port = options.port;

    if (options.txt) {
      this.txt = CiaoService.txtBuffersFromRecord(options.txt);
    }

    // checks if hostname or name are already numbered and adjusts the numbers if necessary
    this.incrementName(true); // must be done before the rebuildServiceRecords call

    this.serviceRecords = this.rebuildServiceRecords(); // build the initial set of records
  }

  public advertise(): Promise<void> {
    debug("[%s] Going to advertise service...", this.name);

    if (this.listeners(ServiceEvent.NAME_CHANGED).length === 0) {
      debug("[%s] WARN: No listeners found for a potential name change on the 'name-change' event!", this.name);
    }
    return new Promise((resolve, reject) => {
      this.emit(InternalServiceEvent.PUBLISH, error => error? reject(error): resolve());
    });
  }

  public end(): Promise<void> {
    debug("[%s] Service is saying goodbye", this.name);
    return new Promise((resolve, reject) => {
      this.emit(InternalServiceEvent.UNPUBLISH, error => error? reject(error): resolve());
    });
  }

  public getFQDN(): string {
    return this.fqdn;
  }

  public getTypePTR(): string {
    return this.typePTR;
  }

  public getSubtypePTRs(): string[] | undefined {
    return this.subTypePTRs;
  }

  public getHostname(): string {
    return this.hostname;
  }

  /**
   * Sets or updates the txt of the service
   * @param txt - the new txt record
   */
  public updateTxt(txt: ServiceTxt): Promise<void> {
    assert(txt, "txt cannot be undefined");

    this.txt = CiaoService.txtBuffersFromRecord(txt);
    debug("[%s] Updating txt record...", this.name);

    return new Promise((resolve, reject) => {
      if (this.serviceState === ServiceState.ANNOUNCED) {
        this.rebuildServiceRecords();
        this.emit(InternalServiceEvent.RECORD_UPDATE, [this.txtRecord()], error => error? reject(error): resolve());
      } else {
        resolve();
      }
    });
  }

  private static txtBuffersFromRecord(txt: ServiceTxt): Buffer[] {
    const result: Buffer[] = [];

    Object.entries(txt).forEach(([key, value]) => {
      const entry = key + "=" + value;
      result.push(Buffer.from(entry));
    });

    return result;
  }

  private handleNetworkChange(update: NetworkUpdate): void {
    if (this.serviceState !== ServiceState.ANNOUNCED) {
      return; // service records are rebuilt short before the announce step
    }

    const added = update.added?.map(network => network.getId()) || [];
    const removed = update.removed?.map(network => network.getId()) || [];
    const updated = update.updated?.map(change => change.networkId) || [];

    debug("[%s] Encountered network update: added: '%s'; updated: '%s'; removed: '%s'", this.name, added.join(", "), updated.join(", "), removed.join(", "));

    const records: AnswerRecord[] = [];

    if (update.updated) {
      for (const change of update.updated) {
        for (const outdated of change.removedAddresses) {
          records.push({
            name: this.hostname,
            type: net.isIPv4(outdated)? Type.A: Type.AAAA,
            ttl: 0,
            data: outdated,
            flush: true,
          });
        }

        for (const updated of change.newAddresses) {
          records.push({
            name: this.hostname,
            type: net.isIPv4(updated)? Type.A: Type.AAAA,
            ttl: 120,
            data: updated,
            flush: true,
          });
        }
      }
    }

    this.rebuildServiceRecords();
    // records for a removed interface are now no longer present after the call above
    // records for a new interface got now built by the call above

    if (records.length > 0) {
      this.emit(InternalServiceEvent.RECORD_UPDATE, records);
    }

    if (added.length > 0) {
      // TODO add support for this. We will need to announce the service on the newly appeared interface
      //  as a name conflict could appear there we would also do a Probing. As we probably do not want
      //  that we have different names on different interfaces we should just Probe an reannounce on ALL interfaces

      // TODO reannounce would need to be delayed until the socket is bound
      console.log("CIAO: [" + this.name + "] Detected a new network interface appearing on the machine. The service probably " +
        "needs to be announced on again on that interface. This is currently unsupported. " +
        "Please restart the program so that the new interface is properly advertised!");
    }
  }

  /**
   * This method is called by the Prober when encountering a conflict on the network.
   * It advices the service to change its name, like incrementing a number appended to the name.
   * So "My Service" will become "My Service (2)", and "My Service (2)" would become "My Service (3)"
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
      const lastDot = this.hostname.lastIndexOf(".");

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

    this.fqdn = this.formatFQDN(); // update the fqdn

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

  rebuildServiceRecords(): ServiceRecords {
    const aRecordMap: Record<NetworkId, ARecord[]> = {};
    const aaaaRecordMap: Record<NetworkId, AAAARecord[]> = {};
    const reverseAddressMap: Record<IPAddress, PTRRecord> = {};
    let subtypePTRs: PTRRecord[] | undefined = undefined;

    for (const network of this.networkManager.getNetworks()) {
      for (const address of network.getAddresses()) {
        const isIpv4 = net.isIPv4(address);

        const record: ARecord | AAAARecord = {
          name: this.hostname,
          type: isIpv4? Type.A: Type.AAAA,
          ttl: 120,
          data: address,
          flush: true,
        };
        const reverseMapping: PTRRecord = {
          name: formatReverseAddressPTRName(address),
          type: Type.PTR,
          ttl: 4500, // 75 minutes
          data: this.hostname,
        };

        const map = isIpv4? aRecordMap: aaaaRecordMap;
        let array = map[network.getId()];
        if (!array) {
          map[network.getId()] = array = [];
        }

        // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
        // @ts-ignore
        array.push(record);
        reverseAddressMap[address] = reverseMapping;
      }
    }

    if (this.subTypePTRs) {
      subtypePTRs = [];
      for (const ptr of this.subTypePTRs) {
        subtypePTRs.push({
          name: ptr,
          type: Type.PTR,
          ttl: 4500, // 75 minutes
          data: this.fqdn,
        });
      }
    }

    debug("[%s] Rebuilding service records...", this.name);

    return this.serviceRecords = {
      ptr: {
        name: this.typePTR,
        type: Type.PTR,
        ttl: 4500, // 75 minutes
        data: this.fqdn,
      },
      subtypePTRs: subtypePTRs, // possibly undefined
      metaQueryPtr: {
        name: Responder.SERVICE_TYPE_ENUMERATION_NAME,
        type: Type.PTR,
        ttl: 4500, // 75 minutes
        data: this.typePTR,
      },
      srv: {
        name: this.fqdn,
        type: Type.SRV,
        ttl: 120,
        data: {
          target: this.hostname, // TODO we could just use the local hostname, and let the service respond to queries from the original responder
          port: this.port,
        },
        flush: true,
      },
      txt: {
        name: this.fqdn,
        type: Type.TXT,
        ttl: 4500, // 75 minutes
        data: this.txt || [],
        flush: true,
      },
      a: aRecordMap,
      aaaa: aaaaRecordMap,
      reverseAddressPTRs: reverseAddressMap,
    };
  }

  ptrRecord(): PTRRecord {
    return CiaoService.copyRecord(this.serviceRecords.ptr);
  }

  subtypePtrRecords(): PTRRecord[] {
    return this.serviceRecords.subtypePTRs? CiaoService.copyRecords(this.serviceRecords.subtypePTRs): [];
  }

  metaQueryPtrRecord(): PTRRecord {
    return CiaoService.copyRecord(this.serviceRecords.metaQueryPtr);
  }

  srvRecord(): SRVRecord {
    return CiaoService.copyRecord(this.serviceRecords.srv);
  }

  txtRecord(): TXTRecord {
    return CiaoService.copyRecord(this.serviceRecords.txt);
  }

  aRecord(id: NetworkId): ARecord[] | undefined {
    const records = this.serviceRecords.a[id];
    return records? CiaoService.copyRecords(records): undefined;
  }

  aaaaRecords(id: NetworkId): AAAARecord[] | undefined {
    const records = this.serviceRecords.aaaa[id];
    return records? CiaoService.copyRecords(records): undefined;
  }

  allAddressRecords(): (ARecord | AAAARecord)[] {
    const records: (ARecord | AAAARecord)[] = [];

    Object.values(this.serviceRecords.a).forEach(recordArray => {
      records.push(...CiaoService.copyRecords(recordArray));
    });
    Object.values(this.serviceRecords.aaaa).forEach(recordArray => {
      records.push(...CiaoService.copyRecords(recordArray));
    });

    return records;
  }

  reverseAddressMapping(address: string): PTRRecord | undefined {
    const record = this.serviceRecords.reverseAddressPTRs[address];
    return record? CiaoService.copyRecord(record): undefined;
  }

  private static copyRecord<T extends RecordBase>(record: T): T {
    // eslint-disable-next-line
    // @ts-ignore
    return {
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      data: record.data,
      class: record.class,
    };
  }

  private static copyRecords<T extends RecordBase>(records: T[]): T[] {
    const result: T[] = [];
    for (const record of records) {
      result.push(CiaoService.copyRecord(record));
    }

    return result;
  }

}
