import { DNSPacket, QClass, QType, RType } from "./DNSPacket";
import { Question } from "./Question";
import { AAAARecord } from "./records/AAAARecord";
import { ARecord } from "./records/ARecord";
import { CNAMERecord } from "./records/CNAMERecord";
import { NSECRecord } from "./records/NSECRecord";
import { PTRRecord } from "./records/PTRRecord";
import { SRVRecord } from "./records/SRVRecord";
import { TXTRecord } from "./records/TXTRecord";
import { runPacketEncodingTest } from "./test-utils";

describe(DNSPacket, () => {
  it("should encode responses", () => {
    const aRecord = new ARecord("example.org", "192.168.0.0");
    aRecord.flushFlag = true;

    runPacketEncodingTest(DNSPacket.createDNSResponsePacketsFromRRSet({
      answers: [
        aRecord,
        new AAAARecord("example.org", "::1"),
        new CNAMERecord("eg.org", "example.org"),
        new NSECRecord("test.local", "test.local", [RType.SRV], 120),
      ],
      additionals: [
        new PTRRecord("test.pointer", "test.local"),
        new SRVRecord("super secret.service", "example.org", 80),
        new TXTRecord("my txt.local", [Buffer.from("key=value")]),
      ],
    }));
  });

  it ("should encode queries", () => {
    const question = new Question("test.local", QType.ANY, true, QClass.ANY);

    runPacketEncodingTest(DNSPacket.createDNSQueryPackets({
      questions: [
        question,
        new Question("test._hap._tcp.local", QType.PTR, false, QClass.IN),
      ],
      answers: [
        new ARecord("test.local.", "192.168.178.1"),
      ],
    })[0]);

    runPacketEncodingTest(DNSPacket.createDNSQueryPackets({
      questions: [
        new Question("test.local", QType.ANY, false, QClass.ANY),
      ],
      authorities: [
        new ARecord("test.local.", "192.168.178.1"),
      ],
    })[0]);
  });

  // Regression: the size checks inside the known-answer splitting loop measured the
  // FIRST packet instead of the packet currently being filled. Once the list had been
  // truncated once, every remaining answer failed both checks and was appended to
  // that already-full first packet, so the split produced an oversized first packet
  // plus one empty truncated packet per remaining answer.
  it("splits a known-answer list across packets without overfilling the first one", () => {
    const udpPayloadSize = 200;

    // 40 PTR records with distinct names, so nothing compresses away to nothing and
    // the list comfortably needs more than one 200 byte packet.
    const answers = Array.from({ length: 40 }, (_, i) =>
      new PTRRecord("_hap._tcp.local.", `instance-number-${i}._hap._tcp.local.`));

    const packets = DNSPacket.createDNSQueryPackets({
      questions: [ new Question("_hap._tcp.local.", QType.PTR, false, QClass.IN) ],
      answers,
    }, udpPayloadSize);

    expect(packets.length).toBeGreaterThan(1);

    // no packet may exceed the payload size, and none may be left empty
    for (const packet of packets) {
      expect(packet.encode().length).toBeLessThanOrEqual(udpPayloadSize);
      expect(packet.questions.size + packet.answers.size).toBeGreaterThan(0);
    }

    // every answer must survive the split exactly once, and every packet except the
    // last must be marked truncated
    const carried = packets.reduce((total, packet) => total + packet.answers.size, 0);
    expect(carried).toBe(answers.length);
    packets.slice(0, -1).forEach(packet => expect(packet.flags.truncation).toBe(true));
    expect(packets[packets.length - 1].flags.truncation).toBeFalsy();
  });
});
