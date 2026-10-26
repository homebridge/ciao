import { CiaoService, InternalServiceEvent, PublishCallback, ServiceEvent, ServiceOptions, ServiceState, UnpublishCallback } from "./CiaoService";
import { TimedSendResult } from "./MDNSServer";
import { NetworkManager } from "./NetworkManager";
import { Responder } from "./Responder";
import { Announcer } from "./responder/Announcer";
import { Prober } from "./responder/Prober";
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

const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;

// The rejected send result the real server resolves for a socket error, which makes a probe query or a goodbye fail when every send carries it.
const failedSend: TimedSendResult = { interface: "en0", reason: new Error("The fake server fails this send."), status: "rejected" };

/* The fake server the advertise-chain rows drive. It binds no socket: every probe query and every packet reads as sent unless a row overrides it, and
 * it reports no bound interface, so an announcement or a goodbye sends nothing until a row names one.
 */
function makeChainServer() {
  return {
    getBoundInterfaceNames: jest.fn((): string[] => []),
    getNetworkManager: jest.fn(() => networkManager),
    send: jest.fn<Promise<TimedSendResult>, [unknown, string]>(async () => ({ interface: "en0", status: "fulfilled" })),
    sendQueryBroadcast: jest.fn<Promise<TimedSendResult[]>, [unknown, CiaoService]>(async () => []),
    shutdown: jest.fn(),
  };
}

type ChainServer = ReturnType<typeof makeChainServer>;

// The services the fake server sent probe queries for, by instance name, in the order the queries went out.
function probedNames(server: ChainServer): string[] {
  return server.sendQueryBroadcast.mock.calls.map(call => call[1].getFQDN().split(".")[0]);
}

/** The Responder internals the advertise-chain rows read or drive directly. */
interface ChainResponder {
  announcedServices: Map<string, CiaoService>;
  advertiseService(service: CiaoService, callback: PublishCallback): Promise<void>;
  probe(service: CiaoService): Promise<void>;
  republishService(service: CiaoService, callback: PublishCallback, delayAnnounce?: boolean): Promise<void>;
  shutdown(): Promise<void>;
  unpublishService(service: CiaoService, callback?: UnpublishCallback): Promise<void>;
}

/* Builds a Responder without running its constructor, which would bind sockets, so every field the constructor initializes is set here by hand: a field
 * left out reads as undefined on the fake where the real Responder always holds a value. The chain starts fulfilled, standing for a bind that finished.
 */
function makeChainResponder(): { internals: ChainResponder; server: ChainServer } {
  const server = makeChainServer();
  const responder = Object.create(Responder.prototype) as Responder;

  Object.assign(responder, {
    announcedServices: new Map(),
    broadcastInterval: undefined,
    currentProber: undefined,
    delayedMulticastResponses: [],
    ignoreUnicastResponseFlag: undefined,
    optionsString: "",
    promiseChain: Promise.resolve(),
    refCount: 1,
    server,
    servicePointer: new Map(),
    shutdownController: new AbortController(),
    truncatedQueries: {},
  });

  return { internals: responder as unknown as ChainResponder, server };
}

/* Creates a service wired to the fake Responder through the internal events Responder.createService binds, every callback a publish or a republish hands
 * the Responder wrapped in a spy first, so a row can count how often each advertisement settled and with what.
 */
function makeChainService(internals: ChainResponder, name: string): { callbacks: jest.Mock[]; service: CiaoService } {
  const service = new CiaoService(networkManager, { name, port: 4711, type: "http" });
  const callbacks: jest.Mock[] = [];
  const recorded = (callback: PublishCallback): PublishCallback => {
    const spy = jest.fn(callback);

    callbacks.push(spy);
    return spy;
  };

  service.on(InternalServiceEvent.PUBLISH, (callback: PublishCallback) => internals.advertiseService(service, recorded(callback)));
  service.on(InternalServiceEvent.UNPUBLISH, (callback: UnpublishCallback) => internals.unpublishService(service, callback));
  service.on(InternalServiceEvent.REPUBLISH, (callback: PublishCallback) => internals.republishService(service, recorded(callback)));

  return { callbacks, service };
}

interface Settlement {
  reason?: unknown;
  state: "pending" | "rejected" | "resolved";
}

// Records how a promise settles, so a row asserts the outcome without awaiting a promise that a defect would leave pending for good.
function track(promise: Promise<unknown>): Settlement {
  const settlement: Settlement = { state: "pending" };

  promise.then(() => {
    settlement.state = "resolved";
  }, reason => {
    settlement.reason = reason;
    settlement.state = "rejected";
  });

  return settlement;
}

// Runs the promise jobs already queued and the ones they queue in turn, firing no timer, as the event loop does before its next timer.
async function drainJobs(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

// Moves the fake clock, running every timer that falls due and the promise jobs between them.
async function advance(milliseconds: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(milliseconds);
  await drainJobs();
}

// Advertises a service and runs the clock past its probing and its last announcement, so it ends ANNOUNCED.
async function makeAnnouncedChainService(internals: ChainResponder, name: string): Promise<{ callbacks: jest.Mock[]; service: CiaoService }> {
  const made = makeChainService(internals, name);

  void made.service.advertise();
  await advance(4000);
  expect(made.service.serviceState).toBe(ServiceState.ANNOUNCED);

  return made;
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

  /* Every service a process advertises shares one Responder, which probes them one at a time. These rows hold several services on one fake Responder and
   * drive the real probe step and Prober, unless a row says otherwise, so each reads how one advertisement's outcome reaches the ones queued with it.
   * Probing a service takes 750 ms on the fake clock, the three queries RFC 6762 8.1 sets going out 250 ms apart with the first sent at once, and the
   * announcements that follow run a few seconds more, which a row advances past where it needs the service ANNOUNCED.
   */
  describe("advertise chain on a shared Responder", () => {
    let announceSpy: jest.SpiedFunction<Announcer["announce"]>;

    beforeEach(() => {
      jest.useFakeTimers();
      announceSpy = jest.spyOn(Announcer.prototype, "announce");
      jest.spyOn(Math, "random").mockReturnValue(0);
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it("a service destroyed before its step runs leaves the next service probed and announced", async () => {
      const { internals } = makeChainResponder();
      const probe = jest.fn(async (service: CiaoService) => {
        service.serviceState = ServiceState.PROBING;
        service.serviceState = ServiceState.PROBED;
      });

      internals.probe = probe;

      const destroyed = makeChainService(internals, "Destroyed").service;
      const advertiseDestroyed = track(destroyed.advertise());

      await destroyed.destroy();
      await drainJobs();
      expect(advertiseDestroyed.state).toBe("resolved");
      expect(probe).not.toHaveBeenCalled();

      const next = makeChainService(internals, "Next").service;
      const advertiseNext = track(next.advertise());

      await drainJobs();

      expect({
        advertiseNext: advertiseNext.state,
        announcedNext: announceSpy.mock.calls.length > 0,
        probedNext: probe.mock.calls.some(call => call[0] === next),
        stateNext: next.serviceState,
      }).toEqual({ advertiseNext: "resolved", announcedNext: true, probedNext: true, stateNext: ServiceState.ANNOUNCING });
    });

    it("end() during real probing cancels the Prober, resolves advertise() without announcing, and the next service is probed and announced", async () => {
      const { internals, server } = makeChainResponder();
      const cancelSpy = jest.spyOn(Prober.prototype, "cancel");
      const ending = makeChainService(internals, "Ending").service;
      const next = makeChainService(internals, "Next").service;
      const advertiseEnding = track(ending.advertise());
      const advertiseNext = track(next.advertise());

      await advance(0);
      expect(ending.serviceState).toBe(ServiceState.PROBING);

      await ending.end();
      await drainJobs();

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(advertiseEnding.state).toBe("resolved");
      expect(ending.serviceState).toBe(ServiceState.UNANNOUNCED);

      await advance(1000);

      expect(advertiseNext.state).toBe("resolved");
      expect(next.serviceState).toBe(ServiceState.ANNOUNCING);
      expect(Array.from(internals.announcedServices.values())).toEqual([next]);
      expect(announceSpy).toHaveBeenCalledTimes(1);
      expect(probedNames(server)).toEqual([ "Ending", "Next", "Next", "Next" ]);
    });

    it("a probe whose sends all fail is retried after 2 s, while the service queued behind it probes at once, and each announces", async () => {
      const { internals, server } = makeChainResponder();
      const failing = makeChainService(internals, "Failing");
      const queued = makeChainService(internals, "Queued").service;
      let releaseQueuedSend: (results: TimedSendResult[]) => void = () => {
        throw new Error("The queued service sent no probe query.");
      };

      server.sendQueryBroadcast
        .mockImplementationOnce(async () => [failedSend])
        // The queued service's first probe query is held past the retry, so the retry lands while that service is still probing.
        .mockImplementationOnce(() => new Promise(resolve => {
          releaseQueuedSend = resolve;
        }));

      const advertiseFailing = track(failing.service.advertise());
      const advertiseQueued = track(queued.advertise());

      await advance(100);
      expect(probedNames(server)).toEqual([ "Failing", "Queued" ]);
      expect(failing.service.serviceState).toBe(ServiceState.UNANNOUNCED);
      expect(queued.serviceState).toBe(ServiceState.PROBING);

      // The retry re-enters at 2 s and waits behind the probing service, as one Prober runs at a time.
      await advance(1900);
      expect(failing.service.serviceState).toBe(ServiceState.UNANNOUNCED);

      releaseQueuedSend([]);
      await advance(2000);

      expect(probedNames(server)).toEqual([ "Failing", "Queued", "Queued", "Queued", "Failing", "Failing", "Failing" ]);
      expect(advertiseFailing.state).toBe("resolved");
      expect(advertiseQueued.state).toBe("resolved");
      expect(failing.callbacks).toHaveLength(1);
      expect(failing.callbacks[0].mock.calls).toEqual([[]]);
      expect(failing.service.serviceState).toBe(ServiceState.ANNOUNCING);
      expect(queued.serviceState).toBe(ServiceState.ANNOUNCING);
    });

    it("end() on a queued advertisement resolves it, its step probes nothing, and the service after it is unaffected", async () => {
      const { internals, server } = makeChainResponder();
      const first = makeChainService(internals, "First").service;
      const ended = makeChainService(internals, "Ended").service;
      const last = makeChainService(internals, "Last").service;

      void first.advertise();

      const advertiseEnded = track(ended.advertise());
      const advertiseLast = track(last.advertise());

      await advance(0);
      expect(first.serviceState).toBe(ServiceState.PROBING);

      const endEnded = track(ended.end());

      await drainJobs();
      expect(endEnded.state).toBe("resolved");

      await advance(2000);

      expect(advertiseEnded.state).toBe("resolved");
      expect(ended.serviceState).toBe(ServiceState.UNANNOUNCED);
      expect(probedNames(server)).toEqual([ "First", "First", "First", "Last", "Last", "Last" ]);
      expect(advertiseLast.state).toBe("resolved");
      expect(first.serviceState).toBe(ServiceState.ANNOUNCING);
      expect(last.serviceState).toBe(ServiceState.ANNOUNCING);
    });

    describe("a second advertise() of the same service", () => {
      it("while probing settles when the attempt it joined succeeds, each callback firing once", async () => {
        const { internals, server } = makeChainResponder();
        const { callbacks, service } = makeChainService(internals, "Twice");
        const firstCall = track(service.advertise());

        await advance(0);
        expect(service.serviceState).toBe(ServiceState.PROBING);

        const secondCall = track(service.advertise());

        await advance(1000);
        await advance(5000);

        expect(firstCall.state).toBe("resolved");
        expect(secondCall.state).toBe("resolved");
        expect(callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
        expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(3);
      });

      it("while probing settles when the attempt it joined fails, while the first caller settles once its retry succeeds", async () => {
        const { internals, server } = makeChainResponder();
        const { callbacks, service } = makeChainService(internals, "Twice");
        let failFirstSend: (results: TimedSendResult[]) => void = () => {
          throw new Error("No probe query was sent.");
        };

        server.sendQueryBroadcast.mockImplementationOnce(() => new Promise(resolve => {
          failFirstSend = resolve;
        }));

        const firstCall = track(service.advertise());

        await drainJobs();
        expect(service.serviceState).toBe(ServiceState.PROBING);

        const secondCall = track(service.advertise());

        await advance(0);
        failFirstSend([failedSend]);
        await drainJobs();

        expect(secondCall.state).toBe("resolved");
        expect(firstCall.state).toBe("pending");

        await advance(3000);
        await advance(5000);

        expect(firstCall.state).toBe("resolved");
        expect(callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
        expect(service.serviceState).toBe(ServiceState.ANNOUNCED);
      });

      it("queued before the first probes settles without probing again, each callback firing once", async () => {
        const { internals, server } = makeChainResponder();
        const { callbacks, service } = makeChainService(internals, "Twice");
        const firstCall = track(service.advertise());
        const secondCall = track(service.advertise());

        await advance(1000);
        await advance(5000);

        expect(firstCall.state).toBe("resolved");
        expect(secondCall.state).toBe("resolved");
        expect(callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
        expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(3);
        expect(announceSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("end() while a goodbye is in progress", () => {
      let releaseGoodbye: (result: TimedSendResult) => void;

      // The service is announced, then its goodbye goes out on one bound interface and is held until the row releases it.
      async function sendingGoodbye(): Promise<{ firstEnd: Settlement; secondEnd: Settlement }> {
        const { internals, server } = makeChainResponder();
        const { service } = await makeAnnouncedChainService(internals, "Leaving");

        server.getBoundInterfaceNames.mockReturnValue(["en0"]);
        server.send.mockImplementationOnce(() => new Promise(resolve => {
          releaseGoodbye = resolve;
        }));

        const firstEnd = track(service.end());
        const secondEnd = track(service.end());

        await advance(0);
        expect(server.send).toHaveBeenCalledTimes(1);
        expect(firstEnd.state).toBe("pending");
        expect(secondEnd.state).toBe("pending");

        return { firstEnd, secondEnd };
      }

      it("settles when the goodbye is sent", async () => {
        const { firstEnd, secondEnd } = await sendingGoodbye();

        releaseGoodbye({ interface: "en0", status: "fulfilled" });
        await drainJobs();

        expect(firstEnd.state).toBe("resolved");
        expect(secondEnd.state).toBe("resolved");
      });

      it("settles when the goodbye fails, the failure logged", async () => {
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => { /* swallow */ });
        const { firstEnd, secondEnd } = await sendingGoodbye();

        releaseGoodbye(failedSend);
        await drainJobs();

        expect(firstEnd.state).toBe("resolved");
        expect(secondEnd.state).toBe("resolved");
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("failed goodbye"));
      });
    });

    it("shutdown() while a probe retry is pending resolves that advertise(), and no probe or timer follows", async () => {
      const { internals, server } = makeChainResponder();
      const { callbacks, service } = makeChainService(internals, "Retrying");

      server.sendQueryBroadcast.mockImplementation(async () => [failedSend]);

      const advertised = track(service.advertise());

      await advance(0);
      expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);

      const shutdown = track(internals.shutdown());

      await drainJobs();

      expect(advertised.state).toBe("resolved");
      expect(callbacks[0].mock.calls).toEqual([[]]);
      expect(shutdown.state).toBe("resolved");
      expect(server.shutdown).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);

      await advance(5000);
      expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(1);
    });

    it("shutdown() while advertisements are queued behind a probing service: none of them probes, and every advertise() resolves", async () => {
      const { internals, server } = makeChainResponder();
      const probing = makeChainService(internals, "Probing").service;
      const queued = [ makeChainService(internals, "Second").service, makeChainService(internals, "Third").service ];
      const advertisements = [ probing, ...queued ].map(service => track(service.advertise()));

      await advance(0);
      expect(probing.serviceState).toBe(ServiceState.PROBING);

      void internals.shutdown();
      await drainJobs();

      expect(advertisements.map(advertisement => advertisement.state)).toEqual([ "resolved", "resolved", "resolved" ]);

      await advance(5000);

      expect(probedNames(server)).toEqual(["Probing"]);
      expect(announceSpy).not.toHaveBeenCalled();
      expect([ probing, ...queued ].map(service => service.serviceState)).toEqual([ ServiceState.UNANNOUNCED, ServiceState.UNANNOUNCED, ServiceState.UNANNOUNCED ]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("end() with a probe query in flight, then an immediate advertise(): the cancelled Prober sends nothing more and renames nothing", async () => {
      const { internals, server } = makeChainResponder();
      const sendProbeRequest = jest.spyOn(Prober.prototype as unknown as { sendProbeRequest(): void }, "sendProbeRequest");
      const { service } = makeChainService(internals, "Kitchen");
      // An announced service under the same name, so a conflict check by any Prober renames the probing service.
      const twin = new CiaoService(networkManager, { name: "Kitchen", port: 4712, type: "http" });
      const nameChanges = jest.fn();
      let releaseCancelledSend: (results: TimedSendResult[]) => void = () => {
        throw new Error("The cancelled Prober sent no probe query.");
      };

      service.on(ServiceEvent.NAME_CHANGED, nameChanges);
      internals.announcedServices.set(twin.getLowerCasedFQDN(), twin);
      server.sendQueryBroadcast.mockImplementationOnce(() => new Promise(resolve => {
        releaseCancelledSend = resolve;
      }));

      void service.advertise();
      await advance(0);

      const cancelledProber = sendProbeRequest.mock.contexts[0];

      await service.end();
      void service.advertise();
      await drainJobs();
      expect(service.serviceState).toBe(ServiceState.PROBING);
      // The new Prober's first query is due at once and has not gone out, so this is its timer and nothing else.
      expect(jest.getTimerCount()).toBe(1);

      releaseCancelledSend([]);
      await drainJobs();

      expect(service.getFQDN()).toBe("Kitchen._http._tcp.local.");
      expect(jest.getTimerCount()).toBe(1);

      // The new Prober's own conflict check renames the service, once.
      await advance(5000);
      expect(sendProbeRequest.mock.contexts.filter(context => context === cancelledProber)).toHaveLength(1);
      expect(nameChanges.mock.calls).toEqual([["Kitchen (2)"]]);
    });

    describe("a republish", () => {
      let exitSpy: jest.SpiedFunction<typeof process.exit>;

      beforeEach(() => {
        exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      });

      it("after a conflict, with its delay pending when shutdown() lands, calls back with no error and probes nothing", async () => {
        const { internals, server } = makeChainResponder();
        const { service } = await makeAnnouncedChainService(internals, "Conflicted");
        const callback = jest.fn();
        const probesBefore = server.sendQueryBroadcast.mock.calls.length;

        void internals.republishService(service, callback, true);
        await drainJobs();
        expect(jest.getTimerCount()).toBe(1);

        void internals.shutdown();
        await drainJobs();

        expect(callback.mock.calls).toEqual([[]]);
        expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(probesBefore);
        expect(jest.getTimerCount()).toBe(0);
      });

      it("after a network change, queued behind a probing service when shutdown() lands, calls back with no error and probes nothing", async () => {
        const { internals, server } = makeChainResponder();
        const changed = await makeAnnouncedChainService(internals, "Changed");
        const probing = makeChainService(internals, "Probing").service;

        void probing.advertise();
        await advance(0);
        expect(probing.serviceState).toBe(ServiceState.PROBING);

        changed.service.handleNetworkInterfaceUpdate({ added: [] });
        await drainJobs();
        expect(changed.service.serviceState).toBe(ServiceState.UNANNOUNCED);

        void internals.shutdown();
        await drainJobs();

        expect(changed.callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(probedNames(server)).toEqual([ "Changed", "Changed", "Changed", "Probing" ]);
      });

      it("after a network change, outside shutdown, probes and announces the service again", async () => {
        const { internals, server } = makeChainResponder();
        const changed = await makeAnnouncedChainService(internals, "Changed");

        changed.service.handleNetworkInterfaceUpdate({ added: [] });
        await advance(1000);

        expect(changed.callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
        expect(exitSpy).not.toHaveBeenCalled();
        expect(probedNames(server)).toEqual([ "Changed", "Changed", "Changed", "Changed", "Changed", "Changed" ]);
        expect(changed.service.serviceState).toBe(ServiceState.ANNOUNCING);
      });
    });

    it("a probe retry whose service a later advertise() has announced meanwhile calls back and leaves that announcement alone", async () => {
      const { internals, server } = makeChainResponder();
      const cancelSpy = jest.spyOn(Announcer.prototype, "cancel");
      const { callbacks, service } = makeChainService(internals, "Retried");

      server.sendQueryBroadcast.mockImplementationOnce(async () => [failedSend]);

      const firstCall = track(service.advertise());

      await advance(100);
      expect(service.serviceState).toBe(ServiceState.UNANNOUNCED);

      const secondCall = track(service.advertise());

      await advance(1000);
      expect(secondCall.state).toBe("resolved");
      expect(service.serviceState).toBe(ServiceState.ANNOUNCING);

      const announcer = service.currentAnnouncer;

      // The retry of the first call falls due at 2 s.
      await advance(1000);

      expect(firstCall.state).toBe("resolved");
      expect(callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(service.currentAnnouncer).toBe(announcer);
      expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(4);
    });
  });
});
