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
    let packet = DNSPacket.createDNSQueryPacket({
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
      expect(truncatedQuery.getTotalWaitTime() < 1000).toBe(true)
      callback();
    });
  }, 1000);

  it("should assemble truncated queries", async () => {
    let packet0 = DNSPacket.createDNSQueryPacket({
      questions: [new Question("test.local", QType.A)],
      answers: [
        answerA1(),
        answerA2(),
      ],
    });
    packet0.flags.truncation = true;

    let packet1 = DNSPacket.createDNSQueryPacket({
      questions: [],
      answers: [
        answerA2(),
        answerA3(),
      ],
    });
    packet1.flags.truncation = true;

    let packet2 = DNSPacket.createDNSQueryPacket({
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

    await PromiseTimeout(60).then(() => {
      const result = query.appendDNSPacket(packet1);
      expect(result).toBe(TruncatedQueryResult.AGAIN_TRUNCATED);
      expect(query.getArrivedPacketCount()).toBe(2);

      return PromiseTimeout(60).then(() => {
        const result = query.appendDNSPacket(packet2);
        expect(result).toBe(TruncatedQueryResult.FINISHED);
        expect(query.getArrivedPacketCount()).toBe(3);

        const packet = query.getPacket();
        expect(packet.questions.size).toBe(1);
        expect(packet.answers.size).toBe(5);
        expect(packet.additionals.size).toBe(0);
        expect(packet.authorities.size).toBe(0);

        expect(packet.answers.has(answerA1().asString())).toBe(true);
        expect(packet.answers.has(answerA2().asString())).toBe(true);
        expect(packet.answers.has(answerA3().asString())).toBe(true);
        expect(packet.answers.has(answerA4().asString())).toBe(true);
        expect(packet.answers.has(answerA5().asString())).toBe(true);
      });
    });
  });
});

/*

const previousQuery = this.truncatedQueries[endpointId];
    if (previousQuery) {
      const truncatedQueryResult = previousQuery.appendDNSPacket(packet);

      switch (truncatedQueryResult) {
        case TruncatedQueryResult.ABORT: // returned when we detect, that continuously TC queries are sent
          debug("[%s] Aborting to wait for more truncated queries. Waited a total of %d ms receiving %d queries",
            endpointId, previousQuery.getTotalWaitTime(), previousQuery.getArrivedPacketCount());
          return;
        case TruncatedQueryResult.AGAIN_TRUNCATED:
          debug("[%s] Received a query marked as truncated, waiting for more to arrive", endpointId);
          return; // wait for the next packet
        case TruncatedQueryResult.FINISHED:
          delete this.truncatedQueries[endpointId];
          packet = previousQuery.getPacket(); // replace packet with the complete deal

          debug("[%s] Last part of the truncated query arrived. Received %d packets taking a total of %d ms",
            endpointId, previousQuery.getArrivedPacketCount(), previousQuery.getTotalWaitTime());
          break;
      }
    } else if (packet.flags.truncation) {
      // RFC 6763 18.5 truncate flag indicates that additional known-answer records follow shortly
      debug("Received truncated query from " + JSON.stringify(endpoint) + " waiting for more to come!");

      const truncatedQuery = new TruncatedQuery(packet);
      this.truncatedQueries[endpointId] = truncatedQuery;
      truncatedQuery.on(TruncatedQueryEvent.TIMEOUT, () => {
        // called when more than 400-500ms pass until the next packet arrives
        debug("[%s] Timeout passed since the last truncated query was received. Discarding %d packets received in %d ms.",
          endpointId, truncatedQuery.getArrivedPacketCount(), truncatedQuery.getTotalWaitTime());
        delete this.truncatedQueries[endpointId];
      });

      return; // wait for the next query
    }
 */
