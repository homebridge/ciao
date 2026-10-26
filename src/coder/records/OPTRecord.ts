import assert from "assert";
import deepEquals from "fast-deep-equal";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export interface OPTOption {
  code: number,
  data: Buffer,
}

export interface OPTFlags {
  dnsSecOK?: boolean,
  zero?: number,
}

export class OPTRecord extends ResourceRecord {

  private static readonly EDNS_VERSION = 0;
  private static readonly DNS_SEC_OK_MASK = 0x8000; // 2 bytes, first bit set
  private static readonly NOT_DNS_SEC_OK_MASK = 0x7FFF;

  readonly udpPayloadSize: number;
  readonly extendedRCode: number;
  readonly ednsVersion: number;
  readonly flags: OPTFlags;
  readonly options: OPTOption[];

  constructor(udpPayloadSize: number, options?: OPTOption[], extendedRCode?: number, flags?: OPTFlags, ednsVersion?: number);
  constructor(header: RecordRepresentation, options?: OPTOption[], extendedRCode?: number, flags?: OPTFlags, ednsVersion?: number)
  constructor(udpPayloadSize: number | RecordRepresentation, options?: OPTOption[], extendedRCode?: number, flags?: OPTFlags, ednsVersion?: number) {
    // Z takes the 15 bits after the DO bit (RFC 6891 6.1.3), so it is masked once, here, and the flags the record stores are the ones its TTL carries.
    const storedFlags: Required<OPTFlags> = {
      dnsSecOK: flags?.dnsSecOK ?? false,
      zero: (flags?.zero ?? 0) & OPTRecord.NOT_DNS_SEC_OK_MASK,
    };

    if (typeof udpPayloadSize === "number") {
      // The record header carries the OPT fields (RFC 6891 6.1.2), so the base encode writes them where it writes every record's header: the CLASS holds
      // the payload size and the TTL the extended rcode, the version and the flags.
      super(".", RType.OPT, OPTRecord.packTTL(extendedRCode || 0, ednsVersion || OPTRecord.EDNS_VERSION, storedFlags), false, udpPayloadSize);
      this.udpPayloadSize = udpPayloadSize;
    } else {
      assert(udpPayloadSize.type === RType.OPT);
      super(udpPayloadSize);
      this.udpPayloadSize = udpPayloadSize.class;
    }

    this.extendedRCode = extendedRCode || 0;
    this.ednsVersion = ednsVersion || OPTRecord.EDNS_VERSION;
    this.flags = storedFlags;
    this.options = options || [];
  }

  protected getRDataEncodingLength(): number {
    let length = 0;

    for (const option of this.options) {
      length += 2 + 2 + option.data.length; // 2 byte code; 2 byte length prefix; binary data
    }

    return length;
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    for (const option of this.options) {
      buffer.writeUInt16BE(option.code, offset);
      offset += 2;

      buffer.writeUInt16BE(option.data.length, offset);
      offset += 2;

      option.data.copy(buffer, offset);
      offset += option.data.length;
    }

    return offset - oldOffset; // written bytes
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<OPTRecord> {
    const oldOffset = offset;

    // The header it is handed carries the OPT fields: its class is the payload size, which the representation constructor reads, and its TTL the
    // extended rcode, the version and the flags, each unpacked with an unsigned shift.
    const extendedRCode = header.ttl >>> 24;
    const ednsVersion = (header.ttl >>> 16) & 0xff;
    const flags: OPTFlags = {
      dnsSecOK: !!(header.ttl & OPTRecord.DNS_SEC_OK_MASK),
      zero: header.ttl & OPTRecord.NOT_DNS_SEC_OK_MASK,
    };

    const options: OPTOption[] = [];
    while (offset < buffer.length) {
      const code = buffer.readUInt16BE(offset);
      offset += 2;

      const length = buffer.readUInt16BE(offset);
      offset += 2;

      const data = buffer.subarray(offset, offset + length);
      offset += length;

      options.push({
        code: code,
        data: data,
      });
    }

    return {
      data: new OPTRecord(header, options, extendedRCode, flags, ednsVersion),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): ResourceRecord {
    return new OPTRecord(this.getRecordRepresentation(), this.options, this.extendedRCode, this.flags, this.ednsVersion);
  }

  public dataAsString(): string {
    return `${this.udpPayloadSize} ${this.extendedRCode} ${this.ednsVersion} ${JSON.stringify(this.flags)} [${this.options
      .map(opt => `${opt.code} ${opt.data.toString("base64")}`).join(",")}]`;
  }

  public dataEquals(record: OPTRecord): boolean {
    return this.udpPayloadSize === record.udpPayloadSize && this.extendedRCode === record.extendedRCode
      && this.ednsVersion === record.ednsVersion
      && OPTRecord.optionsEquality(this.options, record.options) && deepEquals(this.flags, record.flags);
  }

  private static optionsEquality(a: OPTOption[], b: OPTOption[]): boolean {
    // deepEquals on buffers doesn't really work; Buffer.compare avoids
    // the per-byte hex stringification of the previous implementation.
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (a[i].code !== b[i].code) {
        return false;
      } else if (Buffer.compare(a[i].data, b[i].data) !== 0) {
        return false;
      }
    }

    return true;
  }

  /* The TTL field of RFC 6891 6.1.3: the extended rcode in the high octet, the version in the next, then the DO bit and the 15-bit Z. It is read back as
   * an unsigned 32-bit value, since an extended rcode of 128 or more sets the sign bit of the shifted value, which the header's unsigned write refuses.
   * The flags are the ones the constructor stores, Z already held to its 15 bits, so the wire and the stored record carry one value.
   */
  private static packTTL(extendedRCode: number, ednsVersion: number, flags: Required<OPTFlags>): number {
    const flagsField = (flags.dnsSecOK? OPTRecord.DNS_SEC_OK_MASK: 0) | flags.zero;

    return ((extendedRCode << 24) | (ednsVersion << 16) | flagsField) >>> 0;
  }

}
