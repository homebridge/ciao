declare module "@homebridge/dns-packet" {

  export const enum Type {
    // noinspection JSUnusedGlobalSymbols
    A = "A",
    NULL = "NULL",
    AAAA = "AAAA",
    AFSDB = "AFSDB",
    APL = "APL",
    CAA = "CAA",
    CDNSKEY = "CDNSKEY",
    CDS = "CDS",
    CERT = "CERT",
    CNAME = "CNAME",
    DHCID = "DHCID",
    DLV = "DLV",
    DNAME = "DNAME",
    DNSKEY = "DNSKEY",
    DS = "DS",
    HIP = "HIP",
    HINFO = "HINFO",
    IPSECKEY = "IPSECKEY",
    KEY = "KEY",
    KX = "KX",
    LOC = "LOC",
    MX = "MX",
    NAPTR = "NAPTR",
    NS = "NS",
    NSEC = "NSEC",
    NSEC3 = "NSEC3",
    NSEC3PARAM = "NSEC3PARAM",
    PTR = "PTR",
    RRSIG = "RRSIG",
    RP = "RP",
    SIG = "SIG",
    SOA = "SOA",
    SPF = "SPF",
    SRV = "SRV",
    SSHFP = "SSHFP",
    TA = "TA",
    TKEY = "TKEY",
    TLSA = "TSLA",
    TSIG = "TSIG",
    TXT = "TXT",
    AXFR = "AXFR",
    IXFR = "IXFR",
    OPT = "OPT",
    ANY = "ANY",
  }

  export const enum Class { // rrclass
    // noinspection JSUnusedGlobalSymbols
    IN = "IN", // class 1 Internet
    CS = "CS",
    CH = "CH",
    HS = "HS",
    ANY = "ANY",
  }

  export const enum Opcode {
    // noinspection JSUnusedGlobalSymbols
    QUERY = "QUERY",
    IQUERY = "IQUERY",
    STATUS = "STATUS",
    OPCODE_3 = "OPCODE_3",
    NOTIFY = "NOTIFY",
    UPDATE = "UPDATE",
    OPCODE_6 = "OPCODE_6",
    OPCODE_7 = "OPCODE_7",
    OPCODE_8 = "OPCODE_8",
    OPCODE_9 = "OPCODE_9",
    OPCODE_10 = "OPCODE_10",
    OPCODE_11 = "OPCODE_11",
    OPCODE_12 = "OPCODE_12",
    OPCODE_13 = "OPCODE_13",
    OPCODE_14 = "OPCODE_13",
    OPCODE_15 = "OPCODE_13",
  }

  export const enum RCode {
    // noinspection JSUnusedGlobalSymbols
    NOERROR = "NOERROR",
    FROMERR = "FROMERR",
    SERVFAIL = "SERVFAIL",
    NXDOMAIN = "NXDOMAIN",
    NOTIMP = "NOTIMP",
    REFUSED = "REFUSED",
    YXDOMAIN = "YXDOMAIN",
    YXRRSET = "YXRRSET",
    NXRRSET = "NXRRSET",
    NOTAUTH = "NOTAUTH",
    NOTZONE = "NOTZONE",
    RCODE_11 = "RCODE_11",
    RCODE_12 = "RCODE_12",
    RCODE_13 = "RCODE_13",
    RCODE_14 = "RCODE_14",
    RCODE_15 = "RCODE_15",
  }

  // noinspection JSUnusedGlobalSymbols
  export const enum OptionCode {
    // noinspection JSUnusedGlobalSymbols
    OPTION_0 = "OPTION_0",
    LLQ = "LLQ",
    UL = "UL",
    NSID = "NSID",
    OPTION_4 = "OPTION_4",
    DAU = "DAU",
    DHU = "DHU",
    N3U = "N3U",
    CLIENT_SUBNET = "CLIENT_SUBNET",
    EXPIRE = "EXPIRE",
    COOKIE = "COOKIE",
    TCP_KEEPALIVE = "TCP_KEEPALIVE",
    PADDING = "PADDING",
    CHAIN = "CHAIN",
    KEY_TAG = "KEY_TAG",
    DEVICEID = "DEVICEID",
    OPTION_65535 = "OPTION_65535"
  }

  export type QuestionRecord = {
    type: Type;
    name: string;
    class?: Class; // qclass, default IN
    flag_qu?: boolean; // unicast response bit
  }

  export type DecodedAnswerRecord = AnswerRecord & {
    class: Class;
    ttl: number;
    rawData: Buffer;
  }
  // list of supported records is incomplete
  export type AnswerRecord = (ARecord | AAAARecord | HINFORecord | PTRRecord | SRVRecord | TXTRecord | NSECRecord);

  export interface RecordBase {
    type: Type; // rrtype
    name: string;
    class?: Class; // rrclass, default IN
    ttl: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
    flush?: boolean; // cache flush flag
  }

  export interface ARecord extends RecordBase {
    type: Type.A;
    data: string; // ipv4 address
  }

  export interface AAAARecord extends RecordBase {
    type: Type.AAAA;
    data: string; // ipv6 address
  }

  export interface HINFORecord extends RecordBase {
    type: Type.HINFO;
    data: {
      cpu: string;
      os: string;
    };
  }

  export interface PTRRecord extends RecordBase {
    type: Type.PTR;
    data: string; // pointer to another record
  }

  export interface SRVRecord extends RecordBase {
    type: Type.SRV;
    data: {
      port: number;
      target: string; // hostname
      priority?: number;
      weight?: number;
    };
  }

  export interface TXTRecord extends RecordBase {
    type: Type.TXT;
    data: string | Buffer | (string | Buffer)[]; // when decoding value will always be Buffer array
  }

  export interface NSECRecord extends RecordBase { // negative response record
    type: Type.NSEC;
    data: {
      nextDomain: string;
      rrtypes: Type[];
    };
  }

  export interface DecodedDnsPacket {
    id: number;
    type: "response" | "query";
    flags: number;
    flag_qr: boolean;
    flag_aa: boolean; // authoriatative answer // OTODO
    flag_tc: boolean; // truncated response
    flag_rd: boolean; // recursion desired
    flag_ra: boolean; // recursion available
    flag_z: boolean; // zero
    flag_ad: boolean; // authentic data
    flag_cd: boolean; // checking disabled
    opcode: Opcode;
    rcode: RCode;
    questions: QuestionRecord[];
    answers: DecodedAnswerRecord[];
    authorities: DecodedAnswerRecord[];
    additionals: DecodedAnswerRecord[];
  }

  export interface EncodingDnsPacket {
    type?: "query" | "response"; // default is "query"
    id?: number; // default is 0
    flags?: number; // default is 0
    questions?: QuestionRecord[];
    answers?: AnswerRecord[];
    authorities?: AnswerRecord[];
    additionals?: AnswerRecord[];
  }

  export const AUTHORITATIVE_ANSWER: number;
  export const TRUNCATED_RESPONSE: number;
  export const RECURSION_DESIRED: number;
  export const RECURSION_AVAILABLE: number;
  export const AUTHENTIC_DATA: number;
  export const CHECKING_DISABLED: number;
  export const DNSSEC_OK: number;

  export function encode(packet: EncodingDnsPacket, buffer?: Buffer, offset?: number): Buffer;

  export function decode(buffer: Buffer, offset?: number): DecodedDnsPacket;

  export interface Classes {

    toString(kclass: number): Class;

    toClass(name: Class): number;

  }

  export interface Types {

    toString(type: number): Type;

    toType(name: Type): number;

  }

  export const classes: Classes;
  export const types: Types;

}
