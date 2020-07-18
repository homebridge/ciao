import assert from "assert";
import { DNSLabelCoder, Name } from "./DNSLabelCoder";
import { DecodedData, QClass, QType, DNSRecord } from "./DNSPacket";

export class Question implements DNSRecord {

  private static readonly QU_MASK = 0x8000; // 2 bytes, first bit set
  private static readonly NOT_QU_MASK = 0x7FFF;

  readonly name: string;
  readonly type: QType;
  readonly class: QClass;

  unicastResponseFlag = false;

  private trackedName?: Name;

  constructor(name: string, type: QType, unicastResponseFlag = false, clazz = QClass.IN) {
    if (!name.endsWith(".")) {
      name += ".";
    }

    this.name = name;
    this.type = type;
    this.class = clazz;

    this.unicastResponseFlag = unicastResponseFlag;
  }

  public getEstimatedEncodingLength(): number {
    // returns encoding length without considering space saving achieved by message compression
    return DNSLabelCoder.getUncompressedNameLength(this.name) + 4;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public trackNames(coder: DNSLabelCoder, legacyUnicast: boolean): void {
    assert(!this.trackedName, "trackNames can only be called once per DNSLabelCoder!");
    this.trackedName = coder.trackName(this.name);
  }

  public clearNameTracking(): void {
    this.trackedName = undefined;
  }

  public getEncodingLength(coder: DNSLabelCoder): number {
    if (!this.trackedName) {
      assert.fail("Illegal state. Name wasn't yet tracked!");
    }

    return coder.getNameLength(this.trackedName)
      + 4; // 2 bytes type; 2 bytes class
  }

  public encode(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    if (!this.trackedName) {
      assert.fail("Illegal state. Name wasn't yet tracked!");
    }

    const oldOffset = offset;

    const nameLength = coder.encodeName(this.trackedName, offset);
    offset += nameLength;

    buffer.writeUInt16BE(this.type, offset);
    offset += 2;

    let qClass = this.class;
    if (this.unicastResponseFlag) {
      qClass |= Question.QU_MASK;
    }
    buffer.writeUInt16BE(qClass, offset);
    offset += 2;

    return offset - oldOffset; // written bytes
  }

  public static decode(coder: DNSLabelCoder, buffer: Buffer, offset: number): DecodedData<Question> {
    const oldOffset = offset;

    const decodedName = coder.decodeName(offset);
    offset += decodedName.readBytes;

    const type = buffer.readUInt16BE(offset) as QType;
    offset += 2;

    const qClass = buffer.readUInt16BE(offset);
    offset += 2;
    const clazz = (qClass & this.NOT_QU_MASK) as QClass;
    const quFlag = !!(qClass & this.QU_MASK);

    const question = new Question(decodedName.data, type, quFlag, clazz);

    return {
      data: question,
      readBytes: offset - oldOffset,
    };
  }

}
