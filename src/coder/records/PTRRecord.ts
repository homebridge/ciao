import assert from "assert";
import { DNSLabelCoder, Name } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class PTRRecord extends ResourceRecord {

  readonly ptrName: string;

  private trackedPtrName?: Name;

  constructor(name: string, ptrName: string, flushFlag?: boolean, ttl?: number);
  constructor(header: RecordRepresentation, ptrName: string);
  constructor(name: string | RecordRepresentation, ptrName: string, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.PTR, ttl || 120, flushFlag);
    } else {
      assert(name.type === RType.PTR);
      super(name);
    }

    if (!ptrName.endsWith(".")) {
      ptrName += ".";
    }

    this.ptrName = ptrName;
  }

  protected getEstimatedRDataEncodingLength(): number {
    return DNSLabelCoder.getUncompressedNameLength(this.ptrName);
  }

  public trackNames(coder: DNSLabelCoder): void {
    super.trackNames(coder);

    assert(!this.trackedPtrName, "trackNames can only be called once per DNSLabelCoder!");
    this.trackedPtrName = coder.trackName(this.ptrName);
  }

  public finishEncoding(): void {
    super.finishEncoding();
    this.trackedPtrName = undefined;
  }

  protected getRDataEncodingLength(coder: DNSLabelCoder): number {
    if (!this.trackedPtrName) {
      assert.fail("Illegal state. PtrName wasn't yet tracked!");
    }

    return coder.getNameLength(this.trackedPtrName!);
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number, disabledCompression?: boolean): number {
    if (!this.trackedPtrName && !disabledCompression) {
      assert.fail("Illegal state. PtrName wasn't yet tracked!");
    }

    const oldOffset = offset;

    const ptrNameLength = disabledCompression? coder.encodeName(this.ptrName, offset): coder.encodeName(this.trackedPtrName!, offset);
    offset += ptrNameLength;

    return offset - oldOffset; // written bytes
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<PTRRecord> {
    const oldOffset = offset;

    const decodedName = coder.decodeName(offset);
    offset += decodedName.readBytes;

    return {
      data: new PTRRecord(header, decodedName.data),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): PTRRecord {
    return new PTRRecord(this.getRecordRepresentation(), this.ptrName);
  }

  public dataEquals(record: PTRRecord): boolean {
    return this.ptrName === record.ptrName;
  }

}
