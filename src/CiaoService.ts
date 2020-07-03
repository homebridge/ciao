import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import { RType } from "./coder/DNSPacket";
import { AAAARecord } from "./coder/records/AAAARecord";
import { ARecord } from "./coder/records/ARecord";
import { NSECRecord } from "./coder/records/NSECRecord";
import { PTRRecord } from "./coder/records/PTRRecord";
import { SRVRecord } from "./coder/records/SRVRecord";
import { TXTRecord } from "./coder/records/TXTRecord";
import { ResourceRecord } from "./coder/ResourceRecord";
import { Protocol, Responder } from "./index";
import {
  InterfaceName,
  IPAddress,
  NetworkInterface,
  NetworkManager,
  NetworkManagerEvent,
  NetworkUpdate,
} from "./NetworkManager";
import * as domainFormatter from "./util/domain-formatter";
import { formatReverseAddressPTRName } from "./util/domain-formatter";

const debug = createDebug("ciao:CiaoService");

const numberedServiceNamePattern = /^(.*) \((\d+)\)$/; // matches a name lik "My Service (2)"
const numberedHostnamePattern = /^(.*)-\((\d+)\)(\.\w{2,})$/; // matches a hostname like "My-Computer-(2).local."

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
  a: Record<InterfaceName, ARecord>;
  aaaa: Record<InterfaceName, AAAARecord>;
  aaaaR: Record<InterfaceName, AAAARecord>; // routable AAAA
  reverseAddressPTRs: Record<IPAddress, PTRRecord>; // indexed by address
  nsec: NSECRecord;
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
  REPUBLISH = "republish",
  RECORD_UPDATE = "records-update",
  RECORD_UPDATE_ON_INTERFACE = "records-update-interface",
}

export type PublishCallback = (error?: Error) => void;
export type UnpublishCallback = (error?: Error) => void;
export type RecordsUpdateCallback = (error?: Error | null) => void;

export declare interface CiaoService {

  on(event: "name-change", listener: (name: string) => void): this;
  on(event: "hostname-change", listener: (hostname: string) => void): this;

  on(event: InternalServiceEvent.PUBLISH, listener: (callback: PublishCallback) => void): this;
  on(event: InternalServiceEvent.UNPUBLISH, listener: (callback: UnpublishCallback) => void): this;
  on(event: InternalServiceEvent.REPUBLISH, listener: (callback: PublishCallback) => void): this;
  on(event: InternalServiceEvent.RECORD_UPDATE, listener: (records: ResourceRecord[], callback?: (error?: Error | null) => void) => void): this;
  on(event: InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, listener: (name: InterfaceName, records: ResourceRecord[], callback?: RecordsUpdateCallback) => void): this;

  emit(event: ServiceEvent.NAME_CHANGED, name: string): boolean;
  emit(event: ServiceEvent.HOSTNAME_CHANGED, hostname: string): boolean;

  emit(event: InternalServiceEvent.PUBLISH, callback: PublishCallback): boolean;
  emit(event: InternalServiceEvent.UNPUBLISH, callback: UnpublishCallback): boolean;
  emit(event: InternalServiceEvent.REPUBLISH, callback?: PublishCallback): boolean;
  emit(event: InternalServiceEvent.RECORD_UPDATE, records: ResourceRecord[], callback: (error?: Error | null) => void): boolean;
  emit(event: InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, name: InterfaceName, records: ResourceRecord[], callback?: RecordsUpdateCallback): boolean;

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
    this.networkManager.on(NetworkManagerEvent.NETWORK_UPDATE, this.handleNetworkInterfaceUpdate.bind(this));

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

  private handleNetworkInterfaceUpdate(networkUpdate: NetworkUpdate): void {
    if (this.serviceState !== ServiceState.ANNOUNCED) {
      return; // service records are rebuilt short before the announce step
    }

    // we don't care about removed interfaces. We can't sent goodbye records on a non existing interface

    if (networkUpdate.changes) {
      // we could optimize this and don't send the announcement of records if we have also added a new interface
      // Though probing will take at least 750 ms and thus sending it out immediately will get the information out faster.

      for (const change of networkUpdate.changes) {
        const records: ResourceRecord[] = [];

        if (change.outdatedIpv4) {
          records.push(new ARecord(this.hostname, change.outdatedIpv4, true, 0));
          records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedIpv4), this.hostname, false, 0));
        }
        if (change.outdatedIpv6) {
          records.push(new AAAARecord(this.hostname, change.outdatedIpv6, true, 0));
          records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedIpv6), this.hostname, false, 0));
        }
        if (change.outdatedRoutableIpv6) {
          records.push(new AAAARecord(this.hostname, change.outdatedRoutableIpv6, true, 0));
          records.push(new PTRRecord(formatReverseAddressPTRName(change.outdatedRoutableIpv6), this.hostname, false, 0));
        }

        if (change.updatedIpv4) {
          records.push(new ARecord(this.hostname, change.updatedIpv4, true));
          records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedIpv4), this.hostname));
        }
        if (change.updatedIpv6) {
          records.push(new AAAARecord(this.hostname, change.updatedIpv6, true));
          records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedIpv6), this.hostname));
        }
        if (change.updatedRoutableIpv6) {
          records.push(new AAAARecord(this.hostname, change.updatedRoutableIpv6, true));
          records.push(new PTRRecord(formatReverseAddressPTRName(change.updatedRoutableIpv6), this.hostname));
        }

        this.emit(InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, change.name, records);
      }
    }

    this.rebuildServiceRecords();
    // records for a removed interface are now no longer present after the call above
    // records for a new interface got now built by the call above

    if (networkUpdate.added) {
      // a new network interface got added. We must return into probing state,
      // as we don't know if we still own uniqueness for our service name on the new network.
      // To make things easy and keep the SAME name on all networks, we probe on ALL interfaces.

      this.emit(InternalServiceEvent.REPUBLISH, error => {
        if (error) {
          console.log("FATAL Error occurred trying to reannounce service! We can't recover from this!");
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
    debug("[%s] Rebuilding service records...", this.name);

    const aRecordMap: Record<InterfaceName, ARecord> = {};
    const aaaaRecordMap: Record<InterfaceName, AAAARecord> = {};
    const aaaaRoutableRecordMap: Record<InterfaceName, AAAARecord> = {};
    const reverseAddressMap: Record<IPAddress, PTRRecord> = {};
    let subtypePTRs: PTRRecord[] | undefined = undefined;

    for (const [name, networkInterface] of this.networkManager.getInterfaceMap()) {
      if (networkInterface.ipv4) {
        aRecordMap[name] = new ARecord(this.hostname, networkInterface.ipv4, true);
        reverseAddressMap[networkInterface.ipv4] = new PTRRecord(formatReverseAddressPTRName(networkInterface.ipv4), this.hostname);
      }

      if (networkInterface.ipv6) {
        aaaaRecordMap[name] = new AAAARecord(this.hostname, networkInterface.ipv6, true);
        reverseAddressMap[networkInterface.ipv6] = new PTRRecord(formatReverseAddressPTRName(networkInterface.ipv6), this.hostname);
      }

      if (networkInterface.routableIpv6) {
        aaaaRoutableRecordMap[name] = new AAAARecord(this.hostname, networkInterface.routableIpv6, true);
        reverseAddressMap[networkInterface.routableIpv6] = new PTRRecord(formatReverseAddressPTRName(networkInterface.routableIpv6), this.hostname);
      }
    }

    if (this.subTypePTRs) {
      subtypePTRs = [];
      for (const ptr of this.subTypePTRs) {
        subtypePTRs.push(new PTRRecord(ptr, this.fqdn));
      }
    }

    return this.serviceRecords = {
      ptr: new PTRRecord(this.typePTR, this.fqdn),
      subtypePTRs: subtypePTRs, // possibly undefined
      metaQueryPtr: new PTRRecord(Responder.SERVICE_TYPE_ENUMERATION_NAME, this.typePTR),
      // TODO we could just use the local hostname, and let the service respond to queries from the original responder
      srv: new SRVRecord(this.fqdn, this.hostname, this.port, true),
      txt: new TXTRecord(this.fqdn, this.txt || [], true),
      a: aRecordMap,
      aaaa: aaaaRecordMap,
      aaaaR: aaaaRoutableRecordMap,
      reverseAddressPTRs: reverseAddressMap,
      nsec: new NSECRecord(this.hostname, this.hostname, [RType.A, RType.AAAA], true),
    };
  }

  ptrRecord(): PTRRecord {
    return this.serviceRecords.ptr.clone();
  }

  subtypePtrRecords(): PTRRecord[] {
    return this.serviceRecords.subtypePTRs? ResourceRecord.clone(this.serviceRecords.subtypePTRs): [];
  }

  metaQueryPtrRecord(): PTRRecord {
    return this.serviceRecords.metaQueryPtr.clone();
  }

  srvRecord(): SRVRecord {
    return this.serviceRecords.srv.clone();
  }

  txtRecord(): TXTRecord {
    return this.serviceRecords.txt.clone();
  }

  aRecord(id: InterfaceName): ARecord | undefined {
    const record = this.serviceRecords.a[id];
    return record? record.clone(): undefined;
  }

  aaaaRecord(id: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords.aaaa[id];
    return record? record.clone(): undefined;
  }

  aaaaRoutableRecord(id: InterfaceName): AAAARecord | undefined {
    const record = this.serviceRecords.aaaaR[id];
    return record? record.clone(): undefined;
  }

  allAddressRecords(): (ARecord | AAAARecord)[] {
    // TODO only used for probe requests, we should probably not send ALL records to ALL interfaces
    const records: (ARecord | AAAARecord)[] = [];

    Object.values(this.serviceRecords.a).forEach(record => {
      records.push(record.clone());
    });
    Object.values(this.serviceRecords.aaaa).forEach(record => {
      records.push(record.clone());
    });
    Object.values(this.serviceRecords.aaaaR).forEach(record => {
      records.push(record.clone());
    });

    return records;
  }

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
    if (networkInterface.routableIpv6) {
      const reverseRecord = this.serviceRecords.reverseAddressPTRs[networkInterface.routableIpv6];
      if (reverseRecord) {
        records.push(reverseRecord.clone());
      }
    }

    return records;
  }

  nsecRecord(): NSECRecord {
    return this.serviceRecords.nsec.clone();
  }

}
