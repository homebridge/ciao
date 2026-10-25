import { CiaoService, ServiceOptions, ServiceState } from "./CiaoService";
import { NetworkManager } from "./NetworkManager";
import { Responder } from "./Responder";
import { Announcer } from "./responder/Announcer";
import { TXTRecord } from "./coder/records/TXTRecord";

// Build a Responder instance without running the constructor — it would otherwise
// open sockets and start the MDNSServer. We only need a `server` field that lets
// us stub `sendResponseBroadcast` for the record-update path.
function makeBareResponder(broadcastImpl: () => Promise<unknown>): Responder {
  const responder = Object.create(Responder.prototype) as Responder;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (responder as any).server = {
    sendResponseBroadcast: broadcastImpl,
  };
  return responder;
}

function makeAnnouncedService() {
  return {
    serviceState: ServiceState.ANNOUNCED,
    getFQDN: () => "Test._http._tcp.local.",
  };
}

describe(Responder, () => {
  describe("handleServiceRecordUpdate - rejection handling", () => {
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(console, "log").mockImplementation(() => { /* swallow */ });
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    // Regression: handleServiceRecordUpdate only wired the success branch of
    // the broadcast promise, so encode/assert failures inside
    // sendResponseBroadcast surfaced as unhandled rejections (#69-style
    // orphan rejection). The rejection handler must instead notify the
    // optional callback with the underlying error.
    it("forwards a synchronous broadcast rejection to the callback", async () => {
      const cause = new Error("encode failed");
      const responder = makeBareResponder(() => Promise.reject(cause));

      const service = makeAnnouncedService();
      const errors: (Error | undefined)[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (responder as any).handleServiceRecordUpdate(
        service,
        { answers: [], additionals: [] },
        (err?: Error) => errors.push(err),
      );

      // Drain a few microtasks so the rejection handler runs.
      await Promise.resolve();
      await Promise.resolve();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(cause);
      // Failure was also logged so a maintainer can see what happened.
      expect(logSpy).toHaveBeenCalled();
    });

    it("wraps a non-Error rejection reason into an Error for the callback", async () => {
      // sendResponseBroadcast theoretically might reject with a non-Error
      // value; the callback signature is RecordsUpdateCallback and expects an
      // Error. Verify the wrapper.
      const responder = makeBareResponder(() => Promise.reject("encode-string-failure"));

      const service = makeAnnouncedService();
      const errors: (Error | undefined)[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (responder as any).handleServiceRecordUpdate(
        service,
        { answers: [], additionals: [] },
        (err?: Error) => errors.push(err),
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect((errors[0] as Error).message).toBe("encode-string-failure");
    });
  });

  describe("handleServiceRecordUpdate - log call shape", () => {
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest.spyOn(console, "log").mockImplementation(() => { /* swallow */ });
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    // Regression: console.log was passed a stray trailing `true` argument that
    // the formatter helper did not consume — it ended up rendered into the log
    // line. The fix removes the extra argument; assert there is exactly one.
    it("logs the all-failed broadcast as a single string argument", async () => {
      const responder = makeBareResponder(() => Promise.resolve([
        { status: "rejected", interface: "eth0", reason: new Error("a") },
        { status: "rejected", interface: "eth1", reason: new Error("b") },
      ]));

      const service = makeAnnouncedService();
      const callbackErrors: (Error | undefined)[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (responder as any).handleServiceRecordUpdate(
        service,
        { answers: [], additionals: [] },
        (err?: Error) => callbackErrors.push(err),
      );

      // The .then() handler runs on a microtask — wait for it.
      await Promise.resolve();
      await Promise.resolve();

      expect(logSpy).toHaveBeenCalledTimes(1);
      const args = logSpy.mock.calls[0];
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe("string");
      // The stray-arg regression shape would have args[1] === true.
      expect(args[1]).toBeUndefined();

      // And the callback should still be notified with an Error.
      expect(callbackErrors).toHaveLength(1);
      expect(callbackErrors[0]).toBeInstanceOf(Error);
    });
  });

  describe("delayed multicast responses", () => {
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it("logs a failed send instead of throwing out of the timer", () => {
      // The delayed send runs from a timer, so anything other than a missing interface used to be
      // re-thrown there - an uncaught exception, and the end of the host process
      jest.useFakeTimers();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => { /* swallow */ });
      const responder = Object.create(Responder.prototype) as Responder;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (responder as any).delayedMulticastResponses = [];
      (responder as any).server = {
        sendResponse: () => {
          throw new Error("Cannot send packets before server is not bound!");
        },
      };
      const packet = { asLoggingString: () => "", canBeCombinedWith: () => false } as any;

      (responder as any).enqueueDelayedMulticastResponse(packet, "en0", 0);
      /* eslint-enable @typescript-eslint/no-explicit-any */

      expect(() => jest.advanceTimersByTime(200)).not.toThrow();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to send a delayed response on en0"));
    });
  });

  describe("goodbye for a hostname shared with another service (#20)", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    function makeService(options: Partial<ServiceOptions>): CiaoService {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      return new CiaoService(networkManager, { name: "Living Room", type: "http", port: 4711, ...options });
    }

    /** Whether the goodbye for `leaving` withdraws its address records, while `remaining` is still announced. */
    function goodbyeKeepsAddressRecords(leaving: CiaoService, remaining: CiaoService[]): boolean {
      jest.spyOn(Announcer.prototype, "announce").mockReturnValue(new Promise(() => { /* never sent */ }));
      const responder = Object.create(Responder.prototype) as Responder;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (responder as any).server = {};
      (responder as any).announcedServices = new Map(remaining.map(service => [service.getLowerCasedFQDN(), service]));
      (responder as any).goodbye(leaving);
      return (leaving.currentAnnouncer as any).keepAddressRecords;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }

    it("keeps the address records while another service still uses the hostname", () => {
      expect(goodbyeKeepsAddressRecords(makeService({ type: "http" }), [ makeService({ type: "ipp" }) ])).toBe(true);
    });

    it("withdraws the address records once the last service using the hostname leaves", () => {
      expect(goodbyeKeepsAddressRecords(makeService({ type: "http" }), [])).toBe(false);
    });

    it("withdraws the address records when the other service has another hostname", () => {
      expect(goodbyeKeepsAddressRecords(makeService({ type: "http" }), [ makeService({ type: "ipp", hostname: "Kitchen" }) ])).toBe(false);
    });
  });

  describe("TXT conflicts for a service without TXT data", () => {
    function conflictType(txt: Buffer[]): number {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      const service = new CiaoService(networkManager, { name: "No TXT", type: "http", port: 4711 });
      service.rebuildServiceRecords();
      const record = new TXTRecord(service.getFQDN(), txt);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      return (Responder as any).checkRecordConflictType(service, record, { interface: "en0" } as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }

    // 0 is ConflictType.NO_CONFLICT and 1 CONFLICTING_RDATA; the enum is `const`, so not importable here
    it("does not take its own empty TXT record, as it comes back off the network, for a conflict", () => {
      // an empty TXT record is sent as a single empty string (RFC 6763 6.1.) and decodes as one
      expect(conflictType([Buffer.alloc(0)])).toBe(0);
    });

    it("still takes a TXT record with data for a conflict", () => {
      expect(conflictType([Buffer.from("v=1")])).toBe(1);
    });
  });
});
