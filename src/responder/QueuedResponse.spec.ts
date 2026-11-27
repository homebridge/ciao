import { DNSPacket } from "../coder/DNSPacket";
import { ARecord } from "../coder/records/ARecord";
import { QueryResponse } from "./QueryResponse";
import { QueuedResponse } from "./QueuedResponse";

// A response packet answering with one A record for the address given.
function responsePacket(address: string): DNSPacket {
  return DNSPacket.createDNSResponsePacketsFromRRSet({ answers: [new ARecord("test.local", address, true)] });
}

// The addresses of the A records a packet answers with.
function addressesOf(packet: DNSPacket): string[] {
  return [...packet.answers.values()].map(record => (record as ARecord).ipAddress);
}

describe(QueuedResponse, () => {
  it("should not fire after cancel", async () => {
    const packet = DNSPacket.createDNSResponsePacketsFromRRSet({
      answers: [new ARecord("test.local", "192.168.1.1", true)],
    });

    const response = new QueuedResponse(packet, "en0");
    response.calculateRandomDelay();

    const callback = jest.fn();
    response.scheduleResponse(callback);

    response.cancel();

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(callback).not.toHaveBeenCalled();
  });

  describe("on a fake clock", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it.each([ [ 0, 20 ], [ 0.5, 70 ] ])("should fire after a delay between 20 and 120 ms (random %d gives %d ms)", (random, delay) => {
      jest.spyOn(Math, "random").mockReturnValue(random);

      const response = new QueuedResponse(responsePacket("192.168.1.1"), "en0");
      const callback = jest.fn();

      response.calculateRandomDelay();
      expect(response.getTimeTillSent()).toBe(delay);

      response.scheduleResponse(callback);
      jest.advanceTimersByTime(delay - 1);
      expect(callback).not.toHaveBeenCalled();
      expect(response.getTimeSinceCreation()).toBe(delay - 1);

      jest.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(response.getTimeTillSent()).toBe(0);
    });

    it("should say a wait is timely while the later response goes out within 500 ms of this one's creation", () => {
      jest.spyOn(Math, "random").mockReturnValue(1);

      const early = new QueuedResponse(responsePacket("192.168.1.1"), "en0");

      jest.advanceTimersByTime(380);

      // Created 380 ms later with a delay of 120 ms, it goes out exactly 500 ms after the early one was created.
      const inTime = new QueuedResponse(responsePacket("192.168.1.2"), "en0");

      inTime.calculateRandomDelay();
      expect(early.delayWouldBeInTimelyManner(inTime)).toBe(true);

      jest.advanceTimersByTime(1);

      const tooLate = new QueuedResponse(responsePacket("192.168.1.3"), "en0");

      tooLate.calculateRandomDelay();
      expect(early.delayWouldBeInTimelyManner(tooLate)).toBe(false);
    });

    it("should merge into a later response for the same interface, and never fire itself", () => {
      jest.spyOn(Math, "random").mockReturnValue(0);

      const early = new QueuedResponse(responsePacket("192.168.1.1"), "en0");
      const earlyCallback = jest.fn();

      early.calculateRandomDelay();
      early.scheduleResponse(earlyCallback);
      jest.advanceTimersByTime(10);

      const later = new QueuedResponse(responsePacket("192.168.1.2"), "en0");

      later.calculateRandomDelay();

      expect(early.combineWithNextPacketIfPossible(later)).toBe(true);
      expect(early.delayed).toBe(true);
      expect(addressesOf(later.getPacket()).sort()).toEqual([ "192.168.1.1", "192.168.1.2" ]);
      // The merged response is as old as the oldest answer it carries.
      expect(later.getTimeSinceCreation()).toBe(10);

      jest.advanceTimersByTime(500);
      expect(earlyCallback).not.toHaveBeenCalled();
    });

    it("should not merge into a later response for another interface", () => {
      const early = new QueuedResponse(responsePacket("192.168.1.1"), "en0");
      const later = new QueuedResponse(responsePacket("192.168.1.2"), "en1");

      expect(early.combineWithNextPacketIfPossible(later)).toBe(false);
      expect(early.delayed).toBeUndefined();
      expect(addressesOf(later.getPacket())).toEqual(["192.168.1.2"]);
    });

    it("should not merge into a later response when the two do not fit one packet", () => {
      const big = (first: number): DNSPacket => DNSPacket.createDNSResponsePacketsFromRRSet({
        answers: Array.from({ length: 30 }, (_, index) => new ARecord("host-" + (first + index) + ".local", "192.168.1.1", true)),
      });
      const early = new QueuedResponse(big(0), "en0");
      const later = new QueuedResponse(big(100), "en0");

      expect(early.combineWithNextPacketIfPossible(later)).toBe(false);
      expect(later.getPacket().answers.size).toBe(30);
    });

    it("should take in a unique response for the same interface only", () => {
      const queued = new QueuedResponse(responsePacket("192.168.1.1"), "en0");
      const unique = new QueryResponse();

      unique.addAnswer(new ARecord("test.local", "192.168.1.2", true));

      expect(queued.combineWithUniqueResponseIfPossible(unique, "en1")).toBe(false);
      expect(addressesOf(queued.getPacket())).toEqual(["192.168.1.1"]);

      expect(queued.combineWithUniqueResponseIfPossible(unique, "en0")).toBe(true);
      expect(addressesOf(queued.getPacket()).sort()).toEqual([ "192.168.1.1", "192.168.1.2" ]);
    });

    it("should not take in a unique response whose packet header differs, as a legacy unicast response's id does", () => {
      const queued = new QueuedResponse(responsePacket("192.168.1.1"), "en0");
      const legacy = new QueryResponse();

      legacy.addAnswer(new ARecord("test.local", "192.168.1.2", true));
      legacy.markLegacyUnicastResponse(0x1234);

      expect(queued.combineWithUniqueResponseIfPossible(legacy, "en0")).toBe(false);
    });
  });
});
