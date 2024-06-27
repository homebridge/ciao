import assert from "assert";
import net from "net";
import { enlargeIPv6, shortenIPv6 } from "../../util/domain-formatter";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class AAAARecord extends ResourceRecord {

  public static readonly DEFAULT_TTL = 120;

  readonly ipAddress: string;

  constructor(name: string, ipAddress: string, flushFlag?: boolean, ttl?: number, );
  constructor(header: RecordRepresentation, ipAddress: string);
  constructor(name: string | RecordRepresentation, ipAddress: string, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.AAAA, ttl || AAAARecord.DEFAULT_TTL, flushFlag);
    } else {
      assert(name.type === RType.AAAA);
      super(name);
    }

    // Enhanced validation to check for IPv6 and IPv4-mapped IPv6 addresses
    assert(net.isIPv6(ipAddress) || this.isIPv4MappedIPv6(ipAddress), "IP address is not in v6 or IPv4-mapped v6 format!");
    this.ipAddress = ipAddress;
  }
  // Utility method to check for IPv4-mapped IPv6 addresses
  private isIPv4MappedIPv6(ipAddress: string): boolean {
    const ipv4MappedIPv6Regex = /^::ffff:(0{1,4}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])$/i;
    return ipv4MappedIPv6Regex.test(ipAddress);
  }
  
  protected getRDataEncodingLength(): number {
    return 16; // 16 byte ipv6 address
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    const address = enlargeIPv6(this.ipAddress);
    const bytes = address.split(":");
    assert(bytes.length === 8, "invalid ip address");

    for (const byte of bytes) {
      const number = parseInt(byte, 16);
      buffer.writeUInt16BE(number, offset);
      offset += 2;
    }

    return offset - oldOffset; // written bytes
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<AAAARecord> {
    const oldOffset = offset;

    const ipBytes: string[] = new Array(8);

    for (let i = 0; i < 8; i++) {
      const number = buffer.readUInt16BE(offset);
      offset += 2;

      ipBytes[i] = number.toString(16);
    }

    const ipAddress = shortenIPv6(ipBytes.join(":"));

    return {
      data: new AAAARecord(header, ipAddress),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): AAAARecord {
    return new AAAARecord(this.getRecordRepresentation(), this.ipAddress);
  }

  public dataAsString(): string {
    return this.ipAddress;
  }

  public dataEquals(record: AAAARecord): boolean {
    return this.ipAddress === record.ipAddress;
  }

}
