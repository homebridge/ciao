import assert from "assert";
import { dnsLowerCase } from "../../util/dns-equal";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class SRVRecord extends ResourceRecord {

  public static readonly DEFAULT_TTL = 120;

  readonly hostname: string;
  private lowerCasedHostname?: string;
  readonly port: number;
  private readonly priority: number;
  private readonly weight: number;

  constructor(name: string, hostname: string, port: number, flushFlag?: boolean, ttl?: number);
  constructor(header: RecordRepresentation, hostname: string, port: number)
  constructor(name: string | RecordRepresentation, hostname: string, port: number, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.SRV, ttl || SRVRecord.RR_DEFAULT_TTL_SHORT, flushFlag);
    } else {
      assert(name.type === RType.SRV);
      super(name);
    }

    if (!hostname.endsWith(".")) {
      this.hostname = hostname + ".";
    } else {
      this.hostname = hostname;
    }
    this.port = port;

    // priority and weight are not supported to encode or read
    this.priority = 0;
    this.weight = 0;
  }

  public getLowerCasedHostname(): string {
    return this.lowerCasedHostname || (this.lowerCasedHostname = dnsLowerCase(this.hostname));
  }

  protected getRDataEncodingLength(coder: DNSLabelCoder): number {
    return 6 // 2 byte priority; 2 byte weight; 2 byte port;
      // as of RFC 2782 name compression MUST NOT be used for the hostname, though RFC 6762 18.14 specifies it should
      + (coder.legacyUnicastEncoding
        ? coder.getUncompressedNameLength(this.hostname)
        : coder.getNameLength(this.hostname));
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    buffer.writeUInt16BE(this.priority, offset);
    offset += 2;

    buffer.writeUInt16BE(this.weight, offset);
    offset += 2;

    buffer.writeUInt16BE(this.port, offset);
    offset += 2;

    const hostnameLength = coder.legacyUnicastEncoding
      ? coder.encodeUncompressedName(this.hostname, offset)
      : coder.encodeName(this.hostname, offset);
    offset += hostnameLength;

    return offset - oldOffset; // written bytes
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<SRVRecord> {
    const oldOffset = offset;

    //const priority = buffer.readUInt16BE(offset);
    offset += 2;

    //const weight = buffer.readUInt16BE(offset);
    offset += 2;

    const port = buffer.readUInt16BE(offset);
    offset += 2;

    const decodedHostname = coder.decodeName(offset);
    offset += decodedHostname.readBytes;

    return {
      data: new SRVRecord(header, decodedHostname.data, port),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): SRVRecord {
    return new SRVRecord(this.getRecordRepresentation(), this.hostname, this.port);
  }

  public dataAsString(): string {
    return `${this.hostname} ${this.port} ${this.priority} ${this.weight}`;
  }

  public dataEquals(record: SRVRecord): boolean {
    return this.getLowerCasedHostname() === record.getLowerCasedHostname() && this.port === record.port && this.weight === record.weight && this.priority === record.priority;
  }

}
