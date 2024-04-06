import { DNSPacket, QType } from "../coder/DNSPacket";
import { Question } from "../coder/Question";
import { ARecord } from "../coder/records/ARecord";
import { PromiseTimeout } from "../util/promise-utils";
import { TruncatedQuery, TruncatedQueryEvent, TruncatedQueryResult } from "./TruncatedQuery";

const answerA1 = () => {
  return new ARecord("test.local", "1.1.1.1", true);
};
const answerA2 = () => {
  return new ARecord("test.local", "1.1.1.2", true);
};
const answerA3 = () => {
  return new ARecord("test.local", "1.1.1.3", true);
};
const answerA4 = () => {
  return new ARecord("test.local", "1.1.1.4", true);
};
const answerA5 = () => {
  return new ARecord("test.local", "1.1.1.5", true);
};

describe(TruncatedQuery, () => {
  it("should timeout truncated query without a followup query", callback => {
    const packet = DNSPacket.createDNSQueryPacket({
      questions: [new Question("test.local", QType.A)],
      answers: [
        answerA1(),
        answerA2(),
      ],
    });
    packet.flags.truncation = true;

    const truncatedQuery = new TruncatedQuery(packet);
    expect(truncatedQuery.getPacket()).toBe(packet);

    truncatedQuery.on(TruncatedQueryEvent.TIMEOUT, () => {
      expect(truncatedQuery.getArrivedPacketCount()).toBe(1);
      expect(truncatedQuery.getTotalWaitTime() < 1000).toBe(true);
      callback();
    });
  }, 1000);

  it("should assemble truncated queries", async () => {
    const packet0 = DNSPacket.createDNSQueryPacket({
      questions: [new Question("test.local", QType.A)],
      answers: [
        answerA1(),
        answerA2(),
      ],
    });
    packet0.flags.truncation = true;

    const packet1 = DNSPacket.createDNSQueryPacket({
      questions: [],
      answers: [
        answerA2(),
        answerA3(),
      ],
    });
    packet1.flags.truncation = true;

    const packet2 = DNSPacket.createDNSQueryPacket({
      questions: [],
      answers: [
        answerA4(),
        answerA5(),
      ],
    });

    const query = new TruncatedQuery(packet0);
    query.on(TruncatedQueryEvent.TIMEOUT, () => {
      fail(new Error("Truncated Query timed when waiting for second packet"));
    });

    await PromiseTimeout(60).then(async () => {
      const result = query.appendDNSPacket(packet1);
      expect(result).toBe(TruncatedQueryResult.AGAIN_TRUNCATED);
      expect(query.getArrivedPacketCount()).toBe(2);

      await PromiseTimeout(60);
      const result_2 = query.appendDNSPacket(packet2);
      expect(result_2).toBe(TruncatedQueryResult.FINISHED);
      expect(query.getArrivedPacketCount()).toBe(3);
      const packet_1 = query.getPacket();
      expect(packet_1.questions.size).toBe(1);
      expect(packet_1.answers.size).toBe(5);
      expect(packet_1.additionals.size).toBe(0);
      expect(packet_1.authorities.size).toBe(0);
      expect(packet_1.answers.has(answerA1().asString())).toBe(true);
      expect(packet_1.answers.has(answerA2().asString())).toBe(true);
      expect(packet_1.answers.has(answerA3().asString())).toBe(true);
      expect(packet_1.answers.has(answerA4().asString())).toBe(true);
      expect(packet_1.answers.has(answerA5().asString())).toBe(true);
    });
  });
});
