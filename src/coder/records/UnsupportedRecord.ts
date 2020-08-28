import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class UnsupportedRecord extends ResourceRecord {

  readonly data: Buffer;

  constructor(header: RecordRepresentation, data: Buffer) {
    super(header);
    this.data = data;
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    return this.data.copy(buffer, offset);
  }

  protected getRDataEncodingLength(): number {
    return this.data.length;
  }

  public clone(): ResourceRecord {
    return new UnsupportedRecord(this.getRecordRepresentation(), this.data);
  }

  dataEquals(record: UnsupportedRecord): boolean {
    return this.data.toString("hex") === record.data.toString("hex");
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<UnsupportedRecord> {
    const data = buffer.slice(offset);

    return {
      data: new UnsupportedRecord(header, data),
      readBytes: data.length,
    };
  }

}
