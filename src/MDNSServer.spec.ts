import { MDNSServer, SendResultFailedRatio, TimedSendResult } from "./MDNSServer";
import { NetworkUpdate } from "./NetworkManager";
import { DNSPacket } from "./coder/DNSPacket";

// Build an MDNSServer with only the state needed for sent-packet bookkeeping.
// The real constructor spins up a NetworkManager (enumerates OS interfaces) and
// arranges sockets — neither is needed for exercising loopback-suppression logic
// in isolation.
function makeBareServer(): MDNSServer {
  const server = Object.create(MDNSServer.prototype) as MDNSServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).sentPackets = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).sentPacketsCleanupTimer = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).closed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).bound = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).sockets = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).networkManager = { shutdown: () => { /* no-op */ } };
  return server;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const maintain = (s: MDNSServer, iface: string, buf: Buffer) =>
  (s as any).maintainSentPacketsInterface(iface, buf);
const check = (s: MDNSServer, iface: string, buf: Buffer): boolean =>
  (s as any).checkIfPacketWasPreviouslySentFromUs(iface, buf);
const hashPacket = (buf: Buffer): string => (MDNSServer as any).hashPacket(buf);
const sentPacketsMap = (s: MDNSServer): Map<string, Map<string, number[]>> =>
  (s as any).sentPackets;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe(MDNSServer, () => {
  describe("handleUpdatedNetworkInterfaces - IPv4 transitions", () => {
    let server: MDNSServer;

    beforeEach(() => {
      // Create server without binding - no real sockets are opened
      server = new MDNSServer({ handleQuery: () => {}, handleResponse: () => {} });
    });

    afterEach(() => {
      server.getNetworkManager().removeAllListeners();
    });

    it("should handle IPv4 appearing on interface (undefined → address) without crashing", () => {
      const update: NetworkUpdate = {
        changes: [{
          name: "en0",
          outdatedIpv4: undefined,
          updatedIpv4: "192.168.1.100",
        }],
      };

      // Should not throw - before fix this hit assert.fail()
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).handleUpdatedNetworkInterfaces(update);
      }).not.toThrow();
    });

    it("should handle IPv4 disappearing on interface (address → undefined) without crashing", () => {
      const update: NetworkUpdate = {
        changes: [{
          name: "en0",
          outdatedIpv4: "192.168.1.100",
          updatedIpv4: undefined,
        }],
      };

      // Should not throw - before fix this hit assert.fail()
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).handleUpdatedNetworkInterfaces(update);
      }).not.toThrow();
    });

    it("should handle both IPv4 undefined (undefined → undefined) without crashing", () => {
      const update: NetworkUpdate = {
        changes: [{
          name: "en0",
          outdatedIpv4: undefined,
          updatedIpv4: undefined,
        }],
      };

      // No-op case: no IPv4 on either side
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (server as any).handleUpdatedNetworkInterfaces(update);
      }).not.toThrow();
    });
  });

  describe("sendQueryBroadcast aggregation", () => {
    // Regression: the inner loop used results.concat(value) — concat returns a
    // *new* array without mutating, so per-packet results were dropped. Empty
    // results then short-circuited SendResultFailedRatio to 0, hiding total
    // socket failure as a clean success.
    it("accumulates per-packet results across multiple split packets", async () => {
      const server = makeBareServer();
      const packetA = {} as DNSPacket;
      const packetB = {} as DNSPacket;
      const packetsSpy = jest
        .spyOn(DNSPacket, "createDNSQueryPackets")
        .mockReturnValue([packetA, packetB]);

      const perPacketResults: Map<DNSPacket, TimedSendResult[]> = new Map([
        [packetA, [
          { status: "fulfilled", interface: "eth0" },
          { status: "rejected", interface: "eth1", reason: new Error("boom") },
        ]],
        [packetB, [
          { status: "timeout", interface: "eth0" },
          { status: "fulfilled", interface: "eth1" },
        ]],
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).sendOnAllNetworksForService = jest.fn(
        (packet: DNSPacket) => Promise.resolve(perPacketResults.get(packet)!),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await (server as any).sendQueryBroadcast({} as any, {} as any);

      expect(results).toHaveLength(4);
      // SendResultFailedRatio must now see the real outcomes — old behaviour
      // returned [] which silently rounded to 0.
      expect(SendResultFailedRatio(results)).toBeGreaterThan(0);

      packetsSpy.mockRestore();
    });

    it("propagates total socket failure rather than masking it as success", async () => {
      const server = makeBareServer();
      const packetsSpy = jest
        .spyOn(DNSPacket, "createDNSQueryPackets")
        .mockReturnValue([{} as DNSPacket]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).sendOnAllNetworksForService = jest.fn().mockResolvedValue([
        { status: "rejected", interface: "eth0", reason: new Error("a") },
        { status: "rejected", interface: "eth1", reason: new Error("b") },
      ] as TimedSendResult[]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await (server as any).sendQueryBroadcast({} as any, {} as any);

      expect(SendResultFailedRatio(results)).toBe(1);

      packetsSpy.mockRestore();
    });
  });

  describe("sendResponse error reporting", () => {
    // Regression: the constructed Error used result.reason.name (always the
    // string "Error") instead of result.interface, so callers couldn't tell
    // which socket actually failed.
    it("identifies the failing interface in the callback error", done => {
      const server = makeBareServer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).send = jest.fn().mockResolvedValue({
        status: "rejected",
        interface: "eth7",
        reason: new Error("EHOSTUNREACH"),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).sendResponse({}, "eth7", (err?: Error) => {
        expect(err).toBeDefined();
        expect(err!.message).toContain("on eth7");
        expect(err!.message).toContain("EHOSTUNREACH");
        // Old form started with "Encountered socket error on Error:" because
        // result.reason.name evaluates to "Error" — guard against regression.
        expect(err!.message).not.toMatch(/on Error:/);
        done();
      });
    });

    it("preserves the underlying reason message verbatim", done => {
      const server = makeBareServer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).send = jest.fn().mockResolvedValue({
        status: "rejected",
        interface: "lo0",
        reason: new Error("send EBADF"),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server as any).sendResponse({}, "lo0", (err?: Error) => {
        expect(err!.message).toBe("Encountered socket error on lo0: send EBADF");
        done();
      });
    });
  });

  it("SendResultFailedRatio", () => {
    expect(SendResultFailedRatio([
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
    ])).toBe(0);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0"},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0"},
      { status: "timeout", interface: "eth0"},
    ])).toBe(0.6);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "timeout", interface: "eth0"},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
    ])).toBe(1);

    expect(SendResultFailedRatio([])).toBe(0);
  });

  describe("hashPacket", () => {
    it("produces the same hash for byte-equal buffers from different backing memory", () => {
      const a = Buffer.from([0, 1, 2, 3, 0xff, 0x80, 0x7f]);
      const b = Buffer.from([0, 1, 2, 3, 0xff, 0x80, 0x7f]);
      expect(a).not.toBe(b);
      expect(hashPacket(a)).toBe(hashPacket(b));
    });

    it("distinguishes buffers that differ by a single byte", () => {
      const a = Buffer.from([0, 1, 2, 3]);
      const b = Buffer.from([0, 1, 2, 4]);
      expect(hashPacket(a)).not.toBe(hashPacket(b));
    });

    it("preserves all byte values (no lossy UTF-8 collapse for invalid sequences)", () => {
      // Two different invalid UTF-8 sequences would collapse to U+FFFD if hashed via
      // toString("utf-8"); over raw bytes they must remain distinct.
      const a = Buffer.from([0xff, 0xfe]);
      const b = Buffer.from([0xfe, 0xff]);
      expect(hashPacket(a)).not.toBe(hashPacket(b));
    });
  });

  describe("sentPackets loopback suppression", () => {
    it("matches a previously maintained packet exactly once", () => {
      const server = makeBareServer();
      const packet = Buffer.from([1, 2, 3, 4, 5]);

      maintain(server, "eth0", packet);
      expect(check(server, "eth0", packet)).toBe(true);
      // A second loopback of the same packet must not be silenced — we only sent it once.
      expect(check(server, "eth0", packet)).toBe(false);
    });

    it("returns false for a packet never sent on that interface", () => {
      const server = makeBareServer();
      expect(check(server, "eth0", Buffer.from([9, 9, 9]))).toBe(false);
    });

    it("preserves duplicate-packet semantics (two sends -> two matches)", () => {
      // Regression guard: if the store collapses duplicates to a single key/timestamp,
      // the second loopback of a rapidly-repeated packet would be handed to the handler
      // as if it were a legitimate incoming query.
      const server = makeBareServer();
      const packet = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

      maintain(server, "eth0", packet);
      maintain(server, "eth0", packet);

      expect(check(server, "eth0", packet)).toBe(true);
      expect(check(server, "eth0", packet)).toBe(true);
      expect(check(server, "eth0", packet)).toBe(false);
    });

    it("isolates tracking per interface", () => {
      const server = makeBareServer();
      const packet = Buffer.from([7, 7, 7]);

      maintain(server, "eth0", packet);
      expect(check(server, "eth1", packet)).toBe(false);
      expect(check(server, "eth0", packet)).toBe(true);
    });

    it("removes the hash key once its timestamp array is drained", () => {
      const server = makeBareServer();
      const packet = Buffer.from([1, 2, 3]);

      maintain(server, "eth0", packet);
      const ifaceMap = sentPacketsMap(server).get("eth0")!;
      expect(ifaceMap.size).toBe(1);

      check(server, "eth0", packet);
      expect(ifaceMap.size).toBe(0);
    });
  });

  describe("sentPackets cleanup timer", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("evicts unmatched entries once they exceed SENT_PACKETS_TTL", () => {
      const server = makeBareServer();
      const packet = Buffer.from([1, 2, 3]);

      maintain(server, "eth0", packet);
      expect(sentPacketsMap(server).get("eth0")!.size).toBe(1);

      // One full TTL gets the cleanup pass to fire; a hair beyond TTL makes every
      // recorded timestamp strictly older than the cutoff.
      jest.advanceTimersByTime(MDNSServer.SENT_PACKETS_TTL + 1);

      expect(sentPacketsMap(server).get("eth0")!.size).toBe(0);
      // The previously-tracked packet must no longer be silenced — if it arrived now
      // it is a genuine external packet as far as we can tell.
      expect(check(server, "eth0", packet)).toBe(false);
    });

    it("reschedules itself while younger entries remain", () => {
      const server = makeBareServer();
      const oldPacket = Buffer.from([1]);
      const youngPacket = Buffer.from([2]);

      maintain(server, "eth0", oldPacket);
      // Age the first entry partway through its TTL, then record a second packet.
      jest.advanceTimersByTime(MDNSServer.SENT_PACKETS_TTL / 2);
      maintain(server, "eth0", youngPacket);

      // First cleanup fires at t = TTL: oldPacket is now past its cutoff, youngPacket
      // is half-expired and should survive.
      jest.advanceTimersByTime(MDNSServer.SENT_PACKETS_TTL / 2 + 1);
      const ifaceMap = sentPacketsMap(server).get("eth0")!;
      expect(ifaceMap.has(hashPacket(oldPacket))).toBe(false);
      expect(ifaceMap.has(hashPacket(youngPacket))).toBe(true);

      // Advance past the reschedule so the remaining entry also expires.
      jest.advanceTimersByTime(MDNSServer.SENT_PACKETS_TTL);
      expect(ifaceMap.size).toBe(0);
    });

    it("stops rescheduling once the store is drained", () => {
      const server = makeBareServer();
      maintain(server, "eth0", Buffer.from([1]));

      jest.advanceTimersByTime(MDNSServer.SENT_PACKETS_TTL + 1);
      expect(sentPacketsMap(server).get("eth0")!.size).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((server as any).sentPacketsCleanupTimer).toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
