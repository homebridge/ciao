import assert from "assert";
import net, {AddressInfo} from "net";
import * as domainFormatter from "./util/domain-formatter";
import {Protocol} from "./index";
import {
  AAAARecord,
  AnswerRecord,
  ARecord,
  NSECRecord,
  PTRRecord,
  QuestionRecord,
  SRVRecord,
  TXTRecord,
  Type,
} from "@homebridge/dns-packet";
import {MDNSServer} from "./MDNSServer";
import dnsEqual from "./util/dns-equal";
import {EventEmitter} from "events";

const numberedServiceNamePattern = /^(.*) \((\d+)\)$/; // matches a name lik "My Service (2)"

/**
 * This enum defines some commonly used service types.
 * This is also referred to as service name (as of RFC 6763).
 * A service name must not be longer than 15 characters (RFC 6763 7.2).
 */
export const enum ServiceType {
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

export interface ServiceOptions { // TODO adjust name?
  /**
   * Instance Name of the service
   */
  name: string;
  /**
   * Type of the service
   */
  type: ServiceType | string;
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
  // TODO add support for sub types RFC 6763 7.1
  // TODO maybe add support to customize domain name
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceTxt = Record<string, any>;

export const enum ServiceState {
  UNANNOUNCED = "unannounced",
  PROBING = "probing",
  ANNOUNCED = "announced",
  DESTROYED = "destroyed", // TODO can this be equal to unannounced?
}

export const enum ServiceEvent {
  UPDATED = "updated",
  UNPUBLISH = "unpublish",
}

export declare interface CiaoService {

  on(event: ServiceEvent.UPDATED, listener: (type: Type) => void): this;
  on(event: ServiceEvent.UNPUBLISH, listener: () => void): this;

  emit(event: ServiceEvent.UPDATED, type: Type): boolean;
  emit(event: ServiceEvent.UNPUBLISH): boolean;

}

export class CiaoService extends EventEmitter {

  name: string; // TODO maybe private with getters?
  readonly type: ServiceType | string;
  readonly protocol: Protocol;
  // TODO may add support for sub types => a PTR record for every subtype
  readonly domain: string;
  fqdn: string; // fully qualified domain name // TODO maybe private with getters?

  readonly hostname: string;
  readonly port: number;
  private readonly addresses?: string[]; // exposed A and AAAA records if set

  private txt?: Buffer[];

  serviceState = ServiceState.UNANNOUNCED; // this field is entirely controlled by the Responder class

  constructor(options: ServiceOptions) {
    super();
    assert(options, "parameters options is required");
    assert(options.name, "service options parameter 'name' is required");
    assert(options.type, "service options parameter 'type' is required");
    assert(options.port, "service options parameter 'port' is required");
    assert(options.type.length <= 15, "service options parameter 'type' must not be longer than 15 characters");

    this.name = options.name;
    this.type = options.type;
    this.protocol = options.protocol || Protocol.TCP;
    // TODO maybe add subtypes support
    this.domain = options.domain || "local";

    this.fqdn = domainFormatter.stringifyFQDN({
      name: this.name,
      type: this.type,
      protocol: this.protocol,
      domain: this.domain,
    });
    assert(this.fqdn.length <= 255, "A fully qualified domain name cannot be longer than 255 characters");

    this.hostname = domainFormatter.formatHostname(options.hostname || this.name, this.domain); // TODO replace spaces with underscore
    this.port = options.port;
    if (options.addresses) {
      this.addresses = Array.isArray(options.addresses)? options.addresses: [options.addresses];
    }

    if (options.txt) {
      this.txt = CiaoService.txtBuffersFromRecord(options.txt);
    }
  }

  /**
   * Sets or updates the txt of the service
   * @param txt - the new txt record
   */
  public updateTxt(txt: ServiceTxt): void {
    assert(txt, "txt cannot be undefined");

    this.txt = CiaoService.txtBuffersFromRecord(txt);
    this.emit(ServiceEvent.UPDATED, Type.TXT); // notify listeners if there are any
  }

  // TODO add a method to republish? it is possbile in theory

  public unpublish() {
    this.emit(ServiceEvent.UNPUBLISH);
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
  incrementName() {
    let nameBase;
    let number;

    const matcher = this.name.match(numberedServiceNamePattern);

    if (matcher) { // if it matched. Extract the current number
      nameBase = matcher[1];
      number = parseInt(matcher[2]);

      assert(number, "Failed to extract number from " + this.name + ". Resulted in " + number);
    } else {
      nameBase = this.name;
      number = 1;
    }

    number++; // increment the number

    // reassemble the name
    this.name = nameBase + " (" + number + ")";
    // update the fqdn
    this.fqdn = domainFormatter.stringifyFQDN({
      name: this.name,
      type: this.type,
      protocol: this.protocol,
      domain: this.domain,
    });
  }

  // TODO handle renaming for hostname collisions

  answerQuestion(question: QuestionRecord, rinfo: AddressInfo): AnswerRecord[] {
    // This assumes to be called from answerQuestion inside the Responder class and thus that certain
    // preconditions or special cases are already covered.
    // For one we assume classes are already matched.

    const askingAny = question.type === Type.ANY || question.type === Type.CNAME; // we need that quite often below

    // capture exitence for those records to answer with a negative response if those do not exist
    let hasARecord = false;
    let hasAAAARecord = false;

    // we might optimize this a bit in terms of memory consumption
    const records: AnswerRecord[] = [...this.recordsAandAAAA(rinfo), this.recordPTR(), this.recordSRV(), this.recordTXT()]
      .filter(record => { // matching as defined in RFC 6762 6.
        if (record.type === Type.A) {
          hasARecord = true;
        } else if (record.type === Type.AAAA) {
          hasAAAARecord = true;
        }

        return (askingAny || question.type === record.type) // match type equality
          && dnsEqual(question.name, record.name); // match name equality
      });

    // eslint-disable-next-line
    if (false && (!hasARecord || !hasAAAARecord)) {
      // TODO NSEC is currently broken in dns-packet
      // add negative response as defined in RFC 6762 6.1 for record
      // we know we have the owner ship for, but which don't exist

      const nsec: NSECRecord = {
        name: this.fqdn,
        type: Type.NSEC,
        ttl: 120, // use the ttl of A/AAAA
        nextDomain: this.fqdn,
        rrtypes: [],
      };

      if (!hasARecord && (askingAny || question.type === Type.A)) {
        nsec.rrtypes.push(Type.A);
      }
      if (!hasAAAARecord && (askingAny || question.type === Type.AAAA)) {
        nsec.rrtypes.push(Type.AAAA);
      }

      console.log("Adding nsec " + nsec); // TODO remove
      records.push(nsec);
    }

    return records;
  }

  recordsAandAAAA(rinfo?: AddressInfo): (ARecord | AAAARecord)[] {
    const records: (ARecord | AAAARecord)[] = [];

    const addresses = (this.addresses || MDNSServer.getAccessibleAddresses(rinfo));

    addresses.forEach(address => {
      records.push({
        name: this.hostname,
        type: net.isIPv4(address)? Type.A: Type.AAAA,
        ttl: 120,
        data: address,
      });
    });

    return records;
  }

  recordPTR(): PTRRecord {
    return {
      name: domainFormatter.stringifyFQDN({ type: ServiceType.HAP }), // TODO do not regenerate this every time
      type: Type.PTR,
      ttl: 4500, // 75 minutes
      data: this.fqdn,
    };
  }

  recordSRV(): SRVRecord {
    return {
      name: this.fqdn,
      type: Type.SRV,
      ttl: 120,
      data: {
        target: this.hostname,
        port: this.port,
      },
    };
  }

  recordTXT(): TXTRecord {
    return {
      name: this.fqdn,
      type: Type.TXT,
      ttl: 4500, // 75 minutes TODO previously we got 120?
      data: this.txt || [],
    };
  }

}
