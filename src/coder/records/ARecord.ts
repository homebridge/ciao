import assert from "assert";
import net from "net";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class ARecord extends ResourceRecord {

  public static readonly DEFAULT_TTL = 120;

  readonly ipAddress: string;

  constructor(name: string, ipAddress: string, flushFlag?: boolean, ttl?: number);
  constructor(header: RecordRepresentation, ipAddress: string);
  constructor(name: string | RecordRepresentation, ipAddress: string, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.A, ttl || ARecord.DEFAULT_TTL, flushFlag);
    } else {
      assert(name.type === RType.A);
      super(name);
    }

    // Adjust validation to accept IPv4-mapped IPv6 addresses
    const isIPv4 = net.isIPv4(ipAddress);
    //const isIPv4MappedIPv6 = /^::ffff:0{0,4}:((25[0-5]|(2[0-4]|1\d|\d)\d)\.){3}(25[0-5]|(2[0-4]|1\d|\d)\d)$/i.test(ipAddress);
    const isIPv4MappedIPv6 = /^::ffff:(\d{1,3}\.){3}\d{1,3}$/i.test(ipAddress)
    assert(isIPv4 || isIPv4MappedIPv6, "IP address is not in v4 or IPv4-mapped v6 format!");

    // Store the original IP address or convert IPv4-mapped IPv6 to IPv4
    this.ipAddress = isIPv4MappedIPv6 ? ipAddress.split(":").pop() as string : ipAddress;
  }

  protected getRDataEncodingLength(): number {
    return 4; // 4 byte ipv4 address
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    const bytes = this.ipAddress.split(".");
    assert(bytes.length === 4, "invalid ip address");

    for (const byte of bytes) {
      const number = parseInt(byte, 10);
      buffer.writeUInt8(number, offset++);
    }

    return offset - oldOffset; // written bytes
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<ARecord> {
    const oldOffset = offset;

    const ipBytes: string[] = new Array(4);

    for (let i = 0; i < 4; i++) {
      const byte = buffer.readUInt8(offset++);
      ipBytes[i] = byte.toString(10);
    }

    const ipAddress = ipBytes.join(".");

    return {
      data: new ARecord(header, ipAddress),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): ARecord {
    return new ARecord(this.getRecordRepresentation(), this.ipAddress);
  }

  public dataAsString(): string {
    return this.ipAddress;
  }

  public dataEquals(record: ARecord): boolean {
    return this.ipAddress === record.ipAddress;
  }

}
