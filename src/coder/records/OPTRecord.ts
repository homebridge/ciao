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

  constructor(udpPayloadSize: number, options?: OPTOption[], extendedRCode?: number, flags?: OPTFlags, ednsVersion?: number, ttl?: number);
  constructor(header: RecordRepresentation, options?: OPTOption[], extendedRCode?: number, flags?: OPTFlags, ednsVersion?: number, ttl?: number)
  constructor(udpPayloadSize: number | RecordRepresentation, options?: OPTOption[], extendedRCode?: number, flags?: OPTFlags, ednsVersion?: number, ttl?: number) {
    if (typeof udpPayloadSize === "number") {
      super(".", RType.OPT, ttl, false, udpPayloadSize);
      this.udpPayloadSize = udpPayloadSize;
    } else {
      assert(udpPayloadSize.type === RType.OPT);
      super(udpPayloadSize);
      this.udpPayloadSize = udpPayloadSize.class;
    }

    this.extendedRCode = extendedRCode || 0;
    this.ednsVersion = ednsVersion || OPTRecord.EDNS_VERSION;
    this.flags = {
      dnsSecOK: flags?.dnsSecOK || false,
      zero: flags?.zero || 0,
      ...flags,
    };
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

    const classOffset = offset - 8;
    const ttlOffset = offset - 6;

    // just to be sure
    buffer.writeUInt16BE(this.udpPayloadSize, classOffset);

    buffer.writeUInt8(this.extendedRCode, ttlOffset);
    buffer.writeUInt8(this.ednsVersion, ttlOffset + 1);

    let flags = this.flags.zero || 0;
    if (this.flags.dnsSecOK) {
      flags |= OPTRecord.DNS_SEC_OK_MASK;
    }
    buffer.writeUInt16BE(flags, ttlOffset + 2);


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

    const classOffset = offset - 8;
    const ttlOffset = offset - 6;

    const udpPayloadSize = buffer.readUInt16BE(classOffset);
    const extendedRCode = buffer.readUInt8(ttlOffset);
    const ednsVersion = buffer.readUInt8(ttlOffset + 1);

    const flagsField = buffer.readUInt16BE(ttlOffset + 2);
    const flags: OPTFlags = {
      dnsSecOK: !!(flagsField & OPTRecord.DNS_SEC_OK_MASK),
      zero: flagsField & OPTRecord.NOT_DNS_SEC_OK_MASK,
    };

    const options: OPTOption[] = [];
    while (offset < buffer.length) {
      const code = buffer.readUInt16BE(offset);
      offset += 2;

      const length = buffer.readUInt16BE(offset);
      offset += 2;

      const data = buffer.slice(offset, offset + length);
      offset += length;

      options.push({
        code: code,
        data: data,
      });
    }

    header.class = udpPayloadSize;
    header.ttl = 4500; // default

    return {
      data: new OPTRecord(header, options, extendedRCode, flags, ednsVersion),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): ResourceRecord {
    return new OPTRecord(this.getRecordRepresentation(), this.options, this.extendedRCode, this.flags, this.ednsVersion);
  }

  protected dataAsString(): string {
    return `${this.udpPayloadSize} ${this.extendedRCode} ${this.ednsVersion} ${JSON.stringify(this.flags)} [${this.options
      .map(opt => `${opt.code} ${opt.data.toString("base64")}`).join(",")}]`;
  }

  public dataEquals(record: OPTRecord): boolean {
    return this.udpPayloadSize === record.udpPayloadSize && this.extendedRCode === record.extendedRCode
      && this.ednsVersion === record.ednsVersion
      && OPTRecord.optionsEquality(this.options, record.options) && deepEquals(this.flags, record.flags);
  }

  private static optionsEquality(a: OPTOption[], b: OPTOption[]): boolean {
    // deepEquals on buffers doesn't really work
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (a[i].code !== b[i].code) {
        return false;
      } else if (a[i].data.toString("hex") !== b[i].data.toString("hex")) {
        return false;
      }
    }

    return true;
  }

}
