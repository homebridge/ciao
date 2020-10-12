import { AddressInfo } from "net";
import { DNSLabelCoder } from "./DNSLabelCoder";
import { DNSPacket } from "./DNSPacket";
import { Question } from "./Question";
import { ResourceRecord } from "./ResourceRecord";

const decodeContext: AddressInfo = {
  address: "0.0.0.0",
  family: "ipv4",
  port: 5353,
};

export function runRecordEncodingTest(record: Question | ResourceRecord, legacyUnicast = false): void {
  let coder = new DNSLabelCoder(legacyUnicast);

  const length = record.getEncodingLength(coder);
  const buffer = Buffer.alloc(length);
  coder.initBuf(buffer);

  const written = record.encode(coder, buffer, 0);
  expect(written).toBe(buffer.length);

  coder = new DNSLabelCoder(legacyUnicast);
  coder.initBuf(buffer);

  const decodedRecord = record instanceof Question
    ? Question.decode(decodeContext, coder, buffer, 0)
    : ResourceRecord.decode(decodeContext, coder, buffer, 0);
  expect(decodedRecord.readBytes).toBe(buffer.length);

  //
  const record2 = decodedRecord.data;

  coder = new DNSLabelCoder(legacyUnicast);

  const length2 = record2.getEncodingLength(coder);
  const buffer2 = Buffer.allocUnsafe(length2);
  coder.initBuf(buffer2);

  const written2 = record2.encode(coder, buffer2, 0);
  expect(written2).toBe(buffer2.length);

  expect(buffer2).toEqual(buffer);
  expect(record2).toEqual(record);

  if (record2 instanceof ResourceRecord && record instanceof ResourceRecord) {
    // test the equals method
    expect(record2.aboutEqual(record)).toBe(true);

    // test the clone method
    const clone = record.clone();
    expect(clone.aboutEqual(record2)).toBe(true);
    expect(clone).toEqual(record2);
  }
}

export function runPacketEncodingTest(packet: DNSPacket): void {
  const buffer = packet.encode();
  const decodedPacket = DNSPacket.decode(decodeContext, buffer);

  const buffer2 = decodedPacket.encode();

  expect(buffer).toEqual(buffer2);
  expect(decodedPacket).toEqual(packet);
}
