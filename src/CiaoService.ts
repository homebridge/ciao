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
import { EventEmitter } from "events";
import { Protocol } from "./index";
import { NetworkManager } from "./NetworkManager";
import * as domainFormatter from "./util/domain-formatter";

const numberedServiceNamePattern = /^(.*) \((\d+)\)$/; // matches a name lik "My Service (2)"
const numberedHostnamePattern = /^(.*)-(\d+)(\.\w{2,})$/; // matches a hostname like "My-Computer-2.local" TODO host pattern

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
  DACP = "dacp", // digital audio control protocl (iTunes)
  HAP = "hap", // used by HomeKit accessoires
  HOMEKIT = "homekit", // used by home hubs
  HTTP = "http",
  HTTP_ALT = "http_alt", // http alternate
  IPP = "ipp", // internet printing protocol
  IPPS = "ipps", // intenert priting protocol over https
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
   * Define if the service is only reachable by specific address or a set of addresses.
   * By default the service will be advertised to be reachable on any interface.
   */
  addresses?: string | string[];

  /**
   * The protocol the service uses. Default is TCP.
   */
  protocol?: Protocol;
  /**
   * Defines a hostname under which the service can be reached.
   * ".local" (or any custom set domain) will be automatically appended to the hostname.
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
  srv: SRVRecord;
  txt: TXTRecord;
  a: Record<string, ARecord>;
  aaaa: Record<string, AAAARecord[]>;
}

export const enum ServiceEvent {
  UPDATED = "updated",
  PUBLISH = "publish",
  UNPUBLISH = "unpublish",
  // TODO separate Internal and public api events
}

export type PublishCallback = (error?: Error) => void;
export type UnpublishCallback = (error?: Error) => void;

export declare interface CiaoService {

  on(event: ServiceEvent.UPDATED, listener: (type: Type) => void): this;
  on(event: ServiceEvent.PUBLISH, listener: (callback: PublishCallback) => void): this;
  on(event: ServiceEvent.UNPUBLISH, listener: (callback: UnpublishCallback) => void): this;

  emit(event: ServiceEvent.UPDATED, type: Type): boolean;
  emit(event: ServiceEvent.PUBLISH, callback: PublishCallback): boolean;
  emit(event: ServiceEvent.UNPUBLISH, callback: UnpublishCallback): boolean;

}

export class CiaoService extends EventEmitter {

  private readonly networkManager: NetworkManager;

  name: string; // TODO maybe private with getters?
  private readonly type: ServiceType | string;
  private readonly subTypes?: string[];
  private readonly protocol: Protocol;
  private readonly serviceDomain: string; // remember: can't be named "domain" => conflicts with EventEmitter

  private fqdn: string; // fully qualified domain name
  private readonly typePTR: string;
  private readonly subTypePTRs?: string[];

  private hostname: string; // formatted hostname
  readonly port: number;
  // TODO private readonly addresses?: string[]; // user defined set of A and AAAA records // TODO remove this again

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
    // TODO support change listener

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

    // TODO check if the name/fqdn and hostname already is a incremented name and adjust pattern accordingly

    this.hostname = domainFormatter.formatHostname(options.hostname || this.name, this.serviceDomain)
      .replace(/ /g, "-"); // replacing all spaces with dashes in the hostname
    this.port = options.port;

    if (options.addresses) {
      // TODO this.addresses = Array.isArray(options.addresses)? options.addresses: [options.addresses];
    }

    if (options.txt) {
      this.txt = CiaoService.txtBuffersFromRecord(options.txt);
    }

    this.serviceRecords = this.rebuildServiceRecords(); // build the initial set of records
  }

  private formatFQDN(): string {
    if (this.serviceState === ServiceState.ANNOUNCED) { // TODO can we exclude the probing state also?
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
   * Sets or updates the txt of the service
   * @param txt - the new txt record
   */
  public updateTxt(txt: ServiceTxt): void { // TODO maybe also return a promise?
    assert(txt, "txt cannot be undefined");

    this.txt = CiaoService.txtBuffersFromRecord(txt);

    if (this.serviceState === ServiceState.ANNOUNCED) {
      this.rebuildServiceRecords();
      this.emit(ServiceEvent.UPDATED, Type.TXT); // notify listeners if there are any
    }
  }

  public advertise(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emit(ServiceEvent.PUBLISH, error => error? reject(error): resolve());
    });
  }

  public end(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.emit(ServiceEvent.UNPUBLISH, error => error? reject(error): resolve());
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

  private static txtBuffersFromRecord(txt: ServiceTxt): Buffer[] {
    const result: Buffer[] = [];

    Object.entries(txt).forEach(([key, value]) => {
      const entry = key + "=" + value;
      result.push(Buffer.from(entry));
    });

    return result;
  }

  /**
   * This method is called by the Prober when encountering a conflict on the network.
   * It advices the service to change its name, like incrementing a number appended to the name.
   * So "My Service" will become "My Service (2)", and "My Service (2)" would become "My Service (3)"
   */
  incrementName(): void {
    // TODO check if we are in a correct state

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

    // increment the numbers
    nameNumber++;
    hostnameNumber++;

    const newNumber = Math.max(nameNumber, hostnameNumber);

    // reassemble the name
    this.name = `${nameBase} (${newNumber})`;
    this.hostname = `${hostnameBase}-(${newNumber})${hostnameTLD}`;

    this.fqdn = this.formatFQDN(); // update the fqdn

    this.rebuildServiceRecords(); // rebuild all services
  }

  private rebuildServiceRecords(): ServiceRecords {
    const aRecordMap: Record<string, ARecord> = {};
    const aaaaRecordMap: Record<string, AAAARecord[]> = {};
    let subtypePTRs: PTRRecord[] | undefined = undefined;

    for (const networkInterfaces of this.networkManager.getInterfaces()) {
      if (networkInterfaces.ipv4) {
        aRecordMap[networkInterfaces.name] = {
          name: this.hostname,
          type: Type.A,
          ttl: 120,
          data: networkInterfaces.ipv4,
        };
      }

      if (networkInterfaces.ipv6) {
        aaaaRecordMap[networkInterfaces.name] = [{
          name: this.hostname,
          type: Type.AAAA,
          ttl: 120,
          data: networkInterfaces.ipv6,
        }];
      }

      if (networkInterfaces.routeAbleIpv6) {
        let records = aaaaRecordMap[networkInterfaces.name];
        if (!records) {
          aaaaRecordMap[networkInterfaces.name] = records = [];
        }

        for (const ip6 of networkInterfaces.routeAbleIpv6) {
          records.push({
            name: this.hostname,
            type: Type.AAAA,
            ttl: 120,
            data: ip6.address,
          });
        }
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

    return this.serviceRecords = {
      ptr: {
        name: this.typePTR,
        type: Type.PTR,
        ttl: 4500, // 75 minutes
        data: this.fqdn,
      },
      subtypePTRs: subtypePTRs, // possibly undefined
      srv: {
        name: this.fqdn,
        type: Type.SRV,
        ttl: 120,
        data: {
          target: this.hostname,
          port: this.port,
        },
      },
      txt: {
        name: this.fqdn,
        type: Type.TXT,
        ttl: 4500, // 75 minutes // TODO previously we got 120?
        data: this.txt || [],
      },
      a: aRecordMap,
      aaaa: aaaaRecordMap,
    };
  }

  ptrRecord(): PTRRecord {
    return CiaoService.copyRecord(this.serviceRecords.ptr);
  }

  subtypePtrRecords(): PTRRecord[] {
    return this.serviceRecords.subtypePTRs? CiaoService.copyRecords(this.serviceRecords.subtypePTRs): [];
  }

  srvRecord(): SRVRecord {
    return CiaoService.copyRecord(this.serviceRecords.srv);
  }

  txtRecord(): TXTRecord {
    return CiaoService.copyRecord(this.serviceRecords.txt);
  }

  aRecord(networkInterface: string): ARecord | undefined {
    const record = this.serviceRecords.a[networkInterface];
    return record? CiaoService.copyRecord(record): undefined;
  }

  aaaaRecords(networkInterface: string): AAAARecord[] | undefined {
    const records = this.serviceRecords.aaaa[networkInterface];
    return records? CiaoService.copyRecords(records): undefined;
  }

  allAddressRecords(): (ARecord | AAAARecord)[] {
    const records: (ARecord | AAAARecord)[] = [];

    records.push(...CiaoService.copyRecords(Object.values(this.serviceRecords.a)));
    Object.values(this.serviceRecords.aaaa).forEach(recordArray => {
      records.push(...CiaoService.copyRecords(recordArray));
    });

    return records;
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
