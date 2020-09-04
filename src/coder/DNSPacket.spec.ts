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
});
