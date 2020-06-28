import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData } from "../DNSPacket";
import {
  RecordRepresentation,
  ResourceRecord,
} from "../ResourceRecord";

export class UnsupportedRecord extends ResourceRecord {

  readonly data: Buffer;

  constructor(header: RecordRepresentation, data: Buffer) {
    super(header);
    this.data = data;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number, disabledCompression?: boolean): number {
    return this.data.copy(buffer, offset);
  }

  protected getEstimatedRDataEncodingLength(): number {
    return this.data.length;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected getRDataEncodingLength(coder: DNSLabelCoder): number {
    return this.data.length;
  }

  clone(): ResourceRecord {
    return new UnsupportedRecord(this.getRecordRepresentation(), this.data);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dataEquals(record: ResourceRecord): boolean {
    return false;
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<UnsupportedRecord> {
    const data = buffer.slice(offset);

    return {
      data: new UnsupportedRecord(header, data),
      readBytes: data.length,
    };
  }

}
