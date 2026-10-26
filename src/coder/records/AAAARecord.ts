import assert from "assert";
import net from "net";
import { canonicalizeIPv6, enlargeIPv6, shortenIPv6 } from "../../util/domain-formatter";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class AAAARecord extends ResourceRecord {

  public static readonly DEFAULT_TTL = AAAARecord.RR_DEFAULT_TTL_SHORT;

  readonly ipAddress: string;

  /**
   * A record for an address given in any spelling `net.isIPv6` accepts, held in its canonical RFC 5952 text, so `dataEquals` and every lookup keyed by an
   * address compare strings.
   */
  constructor(name: string, ipAddress: string, flushFlag?: boolean, ttl?: number, );
  /**
   * A record whose address text arrives canonical, as a copied record's text and the shortened `toString(16)` hextets of a decoded one are by
   * construction, so it is stored as given without parsing it again.
   */
  constructor(header: RecordRepresentation, ipAddress: string);
  constructor(name: string | RecordRepresentation, ipAddress: string, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.AAAA, ttl || AAAARecord.DEFAULT_TTL, flushFlag);
    } else {
      assert(name.type === RType.AAAA);
      super(name);
    }

    assert(net.isIPv6(ipAddress), "IP address is not in v6 format!");
    // Only an address given by name can arrive in another spelling, so only that overload pays for the canonicalizer's parse.
    this.ipAddress = typeof name === "string"? canonicalizeIPv6(ipAddress): ipAddress;
  }

  protected getRDataEncodingLength(): number {
    return 16; // 16 byte ipv6 address
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    const address = enlargeIPv6(this.ipAddress);
    const hextets = address.split(":");
    assert(hextets.length === 8, "invalid IP address");

    for (const hextet of hextets) {
      const number = parseInt(hextet, 16);
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

    // Each hextet comes from toString(16), lowercase and without leading zeros, so compressing the zero runs is all the address needs to reach its
    // canonical text, the text the representation constructor takes as given.
    const ipAddress = shortenIPv6(ipBytes);

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
