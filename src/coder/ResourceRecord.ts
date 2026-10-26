import assert from "assert";
import createDebug from "debug";
import { AddressInfo } from "net";
import { dnsLowerCase } from "../util/dns-equal";
import { NameLimitExceededError } from "../util/errors";
import { dnsTypeToString } from "./dns-string-utils";
import { DNSLabelCoder, NonCompressionLabelCoder } from "./DNSLabelCoder";
import { DecodedData, DNSRecord, OptionalDecodedData, RClass, RType } from "./DNSPacket";

const debug = createDebug("ciao:decoder");

export interface RecordRepresentation {
  name: string;
  type: RType;
  class: RClass;
  ttl: number;
  flushFlag: boolean;
}

interface RecordHeaderData extends RecordRepresentation {
  rDataLength: number;
}

export type RRDecoder = (coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number) => DecodedData<ResourceRecord>;

export abstract class ResourceRecord implements DNSRecord { // RFC 1035 4.1.3.

  public static readonly typeToRecordDecoder: Map<RType, RRDecoder> = new Map();

  private static readonly FLUSH_MASK = 0x8000; // 2 bytes, first bit set
  private static readonly NOT_FLUSH_MASK = 0x7FFF;

  public static readonly RR_DEFAULT_TTL_SHORT = 120; // 120 seconds
  public static readonly RR_DEFAULT_TTL = 4500; // 75 minutes

  readonly name: string;
  private lowerCasedName?: string;
  readonly type: RType;
  readonly class: RClass;
  ttl: number;

  flushFlag = false;

  protected constructor(headerData: RecordRepresentation);
  protected constructor(name: string, type: RType, ttl?: number, flushFlag?: boolean, clazz?: RClass);
  protected constructor(name: string | RecordRepresentation, type?: RType, ttl: number = ResourceRecord.RR_DEFAULT_TTL, flushFlag = false, clazz: RClass = RClass.IN) {
    if (typeof name === "string") {
      if (!name.endsWith(".")) {
        name = name + ".";
      }

      this.name = name;
      this.type = type!;
      this.class = clazz;
      this.ttl = ttl;
      this.flushFlag = flushFlag;
    } else {
      this.name = name.name;
      this.type = name.type;
      this.class = name.class;
      this.ttl = name.ttl;
      this.flushFlag = name.flushFlag;
    }
  }

  public getLowerCasedName(): string {
    return this.lowerCasedName || (this.lowerCasedName = dnsLowerCase(this.name));
  }

  public getEncodingLength(coder: DNSLabelCoder): number {
    return coder.getNameLength(this.name)
      + 10 // 2 bytes TYPE; 2 bytes class, 4 bytes TTL, 2 bytes RDLength
      + this.getRDataEncodingLength(coder);
  }

  public encode(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    const nameLength = coder.encodeName(this.name, offset);
    offset += nameLength;

    buffer.writeUInt16BE(this.type, offset);
    offset += 2;

    let rClass = this.class;
    if (this.flushFlag) {
      // for pseudo records like OPT, TSIG, TKEY, SIG0 the top bit should not be interpreted as the flush flag
      // though we do not support those (OPT seems to be the only used, though no idea for what [by Apple for mdns])
      rClass |= ResourceRecord.FLUSH_MASK;
    }
    buffer.writeUInt16BE(rClass, offset);
    offset += 2;

    buffer.writeUInt32BE(this.ttl, offset);
    offset += 4;

    const dataLength = this.encodeRData(coder, buffer, offset + 2);

    buffer.writeUInt16BE(dataLength, offset);
    offset += 2 + dataLength;

    return offset - oldOffset; // written bytes
  }

  public getRawData(): Buffer { // returns the rData as a buffer without any message compression (used for probe tiebreaking)
    const coder = NonCompressionLabelCoder.INSTANCE; // this forces uncompressed names

    const length = this.getRDataEncodingLength(coder);
    const buffer = Buffer.allocUnsafe(length);

    coder.initBuf(buffer);

    const writtenBytes = this.encodeRData(coder, buffer, 0);
    assert(writtenBytes === buffer.length, "Didn't completely write to the buffer! (" + writtenBytes + "!=" + buffer.length  +")");

    coder.initBuf(); // reset buffer to undefined

    return buffer;
  }

  protected abstract getRDataEncodingLength(coder: DNSLabelCoder): number;

  protected abstract encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number;

  public abstract dataAsString(): string;

  public abstract clone(): ResourceRecord;

  /**
   * Evaluates if the data section of the record is equal to the supplied record
   * @param record
   */
  public abstract dataEquals(record: ResourceRecord): boolean;

  public static clone<T extends ResourceRecord>(records: T[]): T[] {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    return records.map(record => record.clone());
  }

  protected getRecordRepresentation(): RecordRepresentation {
    return {
      name: this.name,
      type: this.type,
      class: this.class,
      ttl: this.ttl,
      flushFlag: this.flushFlag,
    };
  }

  /**
   * Returns if this and the supplied record are the same (ignoring ttl and flush flag)
   * @param record
   */
  public aboutEqual(record: ResourceRecord): boolean {
    return this.type === record.type && this.name === record.name && this.class === record.class
      && this.dataEquals(record);
  }

  public representsSameData(record: ResourceRecord): boolean {
    return this.type === record.type && this.name === record.name && this.class === record.class;
  }

  public asString(): string {
    // same as aboutEqual, ttl is not included
    return `RR ${this.name} ${this.type} ${this.class} ${this.dataAsString()}`;
  }

  public static decode(context: AddressInfo, coder: DNSLabelCoder, buffer: Buffer, offset: number): OptionalDecodedData<ResourceRecord> {
    const oldOffset = offset;

    const decodedHeader = this.decodeRecordHeader(coder, buffer, offset);
    offset += decodedHeader.readBytes;

    const header = decodedHeader.data;
    const rrDecoder = this.typeToRecordDecoder.get(header.type);
    // A record ends where its RDLENGTH says (RFC 1035 3.2.1), whatever its decoder reads, so the next record always starts there.
    const readBytes = (offset + header.rDataLength) - oldOffset;

    if (!rrDecoder) {
      return { readBytes: readBytes };
    }

    coder.initRRLocation(oldOffset, offset, header.rDataLength); // defines record offset and rdata offset for local compression

    const rdata = buffer.subarray(0, offset + header.rDataLength);

    let decodedRecord;
    try {
      /* The decoder reads its fields from a buffer that ends where the rdata does, so a fixed-size field read past RDLENGTH throws here. A name is read
       * from the coder's buffer, the whole packet, as its compression pointers may lead anywhere in it, so a name can run past RDLENGTH without throwing,
       * and the length the decoder read is held to RDLENGTH below.
       */
      decodedRecord = rrDecoder(coder, header, rdata, offset);
    } catch (error) {
      if (error instanceof NameLimitExceededError) {
        throw error; // the packet as a whole is invalid, no point in reading the remaining records
      }

      debug(`Received malformed rdata section for ${dnsTypeToString(header.type)} ${header.name} ${header.ttl} \
from ${context.address}:${context.port} with data '${rdata.subarray(offset).toString("hex")}': ${error.stack}`);

      return { readBytes: readBytes };
    } finally {
      // The location defines local compression for the current record alone, so it is cleared on every exit, a throw among them.
      coder.clearRRLocation();
    }

    if (decodedRecord.readBytes !== header.rDataLength) {
      debug("Dropping a %s record for %s from %s:%d, whose rdata decoded to %d bytes where its RDLENGTH declares %d.", dnsTypeToString(header.type),
        header.name, context.address, context.port, decodedRecord.readBytes, header.rDataLength);

      return { readBytes: readBytes };
    }

    return {
      data: decodedRecord.data,
      readBytes: readBytes,
    };
  }

  protected static decodeRecordHeader(coder: DNSLabelCoder, buffer: Buffer, offset: number): DecodedData<RecordHeaderData> {
    const oldOffset = offset;

    const decodedName = coder.decodeName(offset);
    offset += decodedName.readBytes;

    const type = buffer.readUInt16BE(offset) as RType;
    offset += 2;

    const rClass = buffer.readUInt16BE(offset);
    offset += 2;

    let clazz;
    let flushFlag = false;
    if (type !== RType.OPT) {
      clazz = (rClass & this.NOT_FLUSH_MASK) as RClass;
      flushFlag = !!(rClass & this.FLUSH_MASK);
    } else {
      // OPT class field encodes udpPayloadSize field
      clazz = rClass;
    }

    const ttl = buffer.readUInt32BE(offset);
    offset += 4;

    const rDataLength = buffer.readUInt16BE(offset);
    offset += 2;

    const rHeader: RecordHeaderData = {
      name: decodedName.data,
      type: type,
      class: clazz,
      ttl: ttl,
      flushFlag: flushFlag,
      rDataLength: rDataLength,
    };

    return {
      data: rHeader,
      readBytes: offset - oldOffset,
    };
  }

}
