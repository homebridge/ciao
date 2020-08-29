import assert from "assert";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

export class TXTRecord extends ResourceRecord {

  readonly txt: Buffer[];

  constructor(name: string, txt: Buffer[], flushFlag?: boolean, ttl?: number);
  constructor(header: RecordRepresentation, txt: Buffer[]);
  constructor(name: string | RecordRepresentation, txt: Buffer[], flushFlag?: boolean, ttl?: number) {
    if (typeof name === "string") {
      super(name, RType.TXT, ttl, flushFlag);
    } else {
      assert(name.type === RType.TXT);
      super(name);
    }

    this.txt = txt;
  }

  protected getRDataEncodingLength(): number {
    let length = 0;

    for (const buffer of this.txt) {
      length += 1 + buffer.length;
      assert(buffer.length <= 255, "One txt character-string can only have a length of 255 chars");
    }

    return length;
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    for (const txt of this.txt) {
      buffer.writeUInt8(txt.length, offset++);
      txt.copy(buffer, offset);
      offset += txt.length;
    }

    return offset - oldOffset; // written bytes
  }

  public clone(): TXTRecord {
    return new TXTRecord(this.getRecordRepresentation(), this.txt);
  }

  public dataAsString(): string {
    return `[${this.txt.map(line => `${line.toString("base64")}`).join(",")}]`;
  }

  public dataEquals(record: TXTRecord): boolean {
    // deepEquals on buffers doesn't really work
    if (this.txt.length !== record.txt.length) {
      return false;
    }

    for (let i = 0; i < this.txt.length; i++) {
      if (this.txt[i].toString("hex") !== record.txt[i].toString("hex")) {
        return false;
      }
    }

    return true;
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<TXTRecord> {
    const oldOffset = offset;

    const txtData: Buffer[] = [];

    while (offset < buffer.length) {
      const length = buffer.readUInt8(offset++);

      txtData.push(buffer.slice(offset, offset + length));
      offset += length;
    }

    return {
      data: new TXTRecord(header, txtData),
      readBytes: offset - oldOffset,
    };
  }

}
