import assert from "assert";
import { DNSLabelCoder, Name } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class CNAMERecord extends ResourceRecord {

  readonly cname: string;

  private trackedCName?: Name;

  constructor(name: string, cname: string, flushFlag?: boolean, ttl?: number);
  constructor(header: RecordRepresentation, cname: string);
  constructor(name: string | RecordRepresentation, cname: string, flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.CNAME, ttl, flushFlag);
    } else {
      assert(name.type === RType.CNAME);
      super(name);
    }

    if (!cname.endsWith(".")) {
      cname += ".";
    }

    this.cname = cname;
  }

  protected getEstimatedRDataEncodingLength(): number {
    return DNSLabelCoder.getUncompressedNameLength(this.cname);
  }

  public trackNames(coder: DNSLabelCoder, legacyUnicast: boolean): void {
    super.trackNames(coder, legacyUnicast);

    assert(!this.trackedCName, "trackNames can only be called once per DNSLabelCoder!");
    this.trackedCName = coder.trackName(this.cname);
  }

  public clearNameTracking(): void {
    super.clearNameTracking();
    this.trackedCName = undefined;
  }

  protected getRDataEncodingLength(coder: DNSLabelCoder): number {
    if (!this.trackedCName) {
      assert.fail("Illegal state. CName wasn't yet tracked!");
    }

    return coder.getNameLength(this.trackedCName);
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number, disabledCompression?: boolean): number {
    if (!this.trackedCName && !disabledCompression) {
      assert.fail("Illegal state. CName wasn't yet tracked!");
    }

    const oldOffset = offset;

    const cnameLength = disabledCompression? coder.encodeName(this.cname, offset): coder.encodeName(this.trackedCName!, offset);
    offset += cnameLength;

    return offset - oldOffset; // written bytes
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<CNAMERecord> {
    const oldOffset = offset;

    const decodedName = coder.decodeName(offset);
    offset += decodedName.readBytes;

    return {
      data: new CNAMERecord(header, decodedName.data),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): CNAMERecord {
    return new CNAMERecord(this.getRecordRepresentation(), this.cname);
  }

  public dataEquals(record: CNAMERecord): boolean {
    return this.cname === record.cname;
  }

}
