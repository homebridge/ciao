import assert from "assert";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class SRVRecord extends ResourceRecord {

  readonly hostname: string;
  readonly port: number;
  private readonly priority: number;
  private readonly weight: number;

  constructor(name: string, hostname: string, port: number, flushFlag?: boolean, ttl?: number);
  constructor(header: RecordRepresentation, hostname: string, port: number)
  constructor(name: string | RecordRepresentation, hostname: string, port: number, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.SRV, ttl || 120, flushFlag);
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

  public dataEquals(record: SRVRecord): boolean {
    return this.hostname === record.hostname && this.port === record.port && this.weight === record.weight && this.priority === record.priority;
  }

}
