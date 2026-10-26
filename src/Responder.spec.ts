import { CiaoService, InternalServiceEvent, PublishCallback, ServiceEvent, ServiceOptions, ServiceState, UnpublishCallback } from "./CiaoService";
import { DNSPacket, QType, RType } from "./coder/DNSPacket";
import { Question } from "./coder/Question";
import { EndpointInfo, MDNSServer, TimedSendResult } from "./MDNSServer";
import { NetworkInterface, NetworkManager } from "./NetworkManager";
import { Responder } from "./Responder";
import { Announcer } from "./responder/Announcer";
import { Prober } from "./responder/Prober";
import { QueryResponse } from "./responder/QueryResponse";
import { NSECRecord } from "./coder/records/NSECRecord";
import { PTRRecord } from "./coder/records/PTRRecord";
import { TXTRecord } from "./coder/records/TXTRecord";
import { ResourceRecord } from "./coder/ResourceRecord";

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

/** The Responder internals the advertise-chain and answer rows read or drive directly. */
interface ChainResponder {
  announcedServices: Map<string, CiaoService>;
  servicePointer: Map<string, string[]>;
  advertiseService(service: CiaoService, callback: PublishCallback): Promise<void>;
  answerQuestion(question: Question, endpoint: EndpointInfo): QueryResponse[];
  probe(service: CiaoService): Promise<void>;
  republishService(service: CiaoService, callback: PublishCallback, delayAnnounce?: boolean): Promise<void>;
  retryAdvertisement(service: CiaoService, callback: PublishCallback): Promise<void>;
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
function makeChainService(internals: ChainResponder, name: string, options: Partial<ServiceOptions> = {}): { callbacks: jest.Mock[]; service: CiaoService } {
  const service = new CiaoService(networkManager, { name, port: 4711, type: "http", ...options });
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

/* A service announced on a Responder built without its constructor, as the answer rows read it: its records are built from an interface map holding en0
 * with the addresses given, and the Responder's pointers name the service and its subtype as announcing it records them. A question is asked on the
 * interface given, en0 unless a row names another, such as en0's IPv6 socket "en0/6".
 */
function makeAnsweringResponder(addresses: Partial<NetworkInterface>, askedOn = "en0"): { answer: (name: string, type: QType) => DNSPacket[]; service: CiaoService } {
  const en0: NetworkInterface = { name: "en0", loopback: false, mac: "00:00:5e:00:53:01", ...addresses };
  const manager = { getInterfaceMap: () => new Map([[ en0.name, en0 ]]) } as unknown as NetworkManager;
  const service = new CiaoService(manager, { name: "Kitchen", port: 4711, subtypes: ["primary"], type: "hap" });
  const { internals } = makeChainResponder();

  service.rebuildServiceRecords();
  internals.announcedServices.set(service.getLowerCasedFQDN(), service);
  internals.servicePointer.set(Responder.SERVICE_TYPE_ENUMERATION_NAME, [service.getLowerCasedTypePTR()]);
  internals.servicePointer.set(service.getLowerCasedTypePTR(), [service.getLowerCasedFQDN()]);

  for (const subtypePTR of service.getLowerCasedSubtypePTRs() ?? []) {
    internals.servicePointer.set(subtypePTR, [service.getLowerCasedFQDN()]);
  }

  const endpoint: EndpointInfo = { address: "192.0.2.9", interface: askedOn, port: MDNSServer.MDNS_PORT };
  const answer = (name: string, type: QType): DNSPacket[] => internals.answerQuestion(new Question(name, type, false), endpoint)
    .map(response => response.asPacket());

  return { answer, service };
}

// The types of a section's records, in the order the response holds them.
function typesOf(records: Map<string, ResourceRecord>): RType[] {
  return [...records.values()].map(record => record.type);
}

// The types the bitmap of a section's NSEC record for the name lists, or undefined when the section holds no NSEC record for it.
function nsecTypesOf(records: Map<string, ResourceRecord>, name: string): RType[] | undefined {
  const record = [...records.values()].find(candidate => candidate.type === RType.NSEC && candidate.name === name) as NSECRecord | undefined;

  return record?.rrTypeWindows.flatMap(window => window.rrtypes);
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

  describe("periodic broadcasts", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    // A responder whose server holds the named sockets of one dual-stack interface and answers each question with a fresh PTR response. A send
    // naming a socket the server does not hold throws, as the server's own send does.
    function broadcastOn(bound: string[]) {
      const networkInterface = { name: "eth0", loopback: false, mac: "00:00:00:00:00:00", ipv4: "192.168.1.2", ipv4Netaddress: "192.168.1.0", ipv6: "fe80::1" };
      const sendResponse = jest.fn((packet: unknown, name: string) => {
        if (!bound.includes(name)) {
          throw new Error("Could not find socket for given network interface '" + name + "'");
        }
      });
      const responder = Object.create(Responder.prototype) as Responder;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (responder as any).server = {
        getNetworkManager: () => ({ getInterfaceMap: () => new Map([[networkInterface.name, networkInterface]]) }),
        getBoundInterfaceNames: () => bound.values(),
        sendResponse,
      };
      (responder as any).answerQuestion = () => {
        const response = new QueryResponse();
        response.addAnswer(new PTRRecord("_hap._tcp.local.", "Test._hap._tcp.local."));
        return [response];
      };
      const broadcast = () => (responder as any).handlePeriodicBroadcasts();
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return { broadcast, sendResponse };
    }

    it("sends on the IPv6 socket of an interface whose IPv4 socket is not bound", () => {
      const { broadcast, sendResponse } = broadcastOn(["eth0/6"]);

      expect(broadcast).not.toThrow();
      expect(sendResponse).toHaveBeenCalled();
      expect(sendResponse.mock.calls.map(call => call[1])).toStrictEqual(sendResponse.mock.calls.map(() => "eth0/6"));
    });

    it("sends on the IPv4 socket of an interface whose IPv4 and IPv6 sockets are bound", () => {
      const { broadcast, sendResponse } = broadcastOn(["eth0", "eth0/6"]);

      expect(broadcast).not.toThrow();
      expect(sendResponse).toHaveBeenCalled();
      expect(sendResponse.mock.calls.map(call => call[1])).toStrictEqual(sendResponse.mock.calls.map(() => "eth0"));
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

    it("shutdown() with one goodbye failing and one still pending sends the pending goodbye before the server shuts down, then rejects", async () => {
      const { internals, server } = makeChainResponder();

      await makeAnnouncedChainService(internals, "Failing");
      await makeAnnouncedChainService(internals, "Pending");

      const order: string[] = [];
      let releasePendingGoodbye: (result: TimedSendResult) => void = () => {
        throw new Error("The pending goodbye was never sent.");
      };

      // The goodbyes go out on one bound interface in the order the services were announced: the first fails at once, the second is held.
      server.getBoundInterfaceNames.mockReturnValue(["en0"]);
      server.send
        .mockImplementationOnce(async () => failedSend)
        .mockImplementationOnce(() => new Promise(resolve => {
          releasePendingGoodbye = resolve;
        }));
      server.shutdown.mockImplementation(() => {
        order.push("server shut down");
      });

      const shutdown = track(internals.shutdown());

      await advance(0);
      expect(server.send).toHaveBeenCalledTimes(2);
      expect(server.shutdown).not.toHaveBeenCalled();
      expect(shutdown.state).toBe("pending");

      order.push("pending goodbye sent");
      releasePendingGoodbye({ interface: "en0", status: "fulfilled" });
      await drainJobs();

      expect(order).toEqual([ "pending goodbye sent", "server shut down" ]);
      expect(shutdown.state).toBe("rejected");
      expect(shutdown.reason).toEqual(new Error("Goodbye failed as of socket errors!"));

      // Each goodbye's send races a timeout that expires on its own, so the row reads the timers once that has passed.
      await advance(MDNSServer.SEND_TIMEOUT);
      expect(jest.getTimerCount()).toBe(0);
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

    it("an announce retry whose service a later advertise() is announcing meanwhile leaves that announcement alone and probes nothing", async () => {
      const { internals, server } = makeChainResponder();
      const cancelSpy = jest.spyOn(Announcer.prototype, "cancel");
      const retrySpy = jest.spyOn(internals, "retryAdvertisement");
      const { callbacks, service } = makeChainService(internals, "Reannounced");

      // The first announcement goes out on one bound interface and fails there, at 750 ms once probing has finished, so its retry falls due at 2750 ms.
      server.getBoundInterfaceNames.mockReturnValue(["en0"]);
      server.send.mockImplementationOnce(async () => failedSend);

      const firstCall = track(service.advertise());

      await advance(800);
      expect(firstCall.state).toBe("resolved");
      expect(service.serviceState).toBe(ServiceState.UNANNOUNCED);
      expect(retrySpy).toHaveBeenCalledTimes(1);

      // The first call settled when announcing began, so only the retry's own promise shows that the retry ran before the reads below.
      const retry = track(retrySpy.mock.results[0].value);
      const secondCall = track(service.advertise());

      await advance(1000);
      expect(secondCall.state).toBe("resolved");
      expect(service.serviceState).toBe(ServiceState.ANNOUNCING);

      const announcer = service.currentAnnouncer;

      await advance(1000);

      expect(retry.state).toBe("resolved");
      expect(callbacks.map(callback => callback.mock.calls)).toEqual([ [[]], [[]] ]);
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(service.currentAnnouncer).toBe(announcer);
      expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(6);
      expect(service.serviceState).toBe(ServiceState.ANNOUNCING);
    });

    /* A conflict with an announced service of the same name renames the probing one. Its Prober checks for that conflict once its first query is out, and
     * probes again one second after the rename, so a rename that fits is probed and announced well inside two seconds.
     */
    describe("a conflict rename", () => {
      it("of a name the number would carry past 63 octets shortens the name, and advertise() resolves under it", async () => {
        const { internals } = makeChainResponder();
        const { service } = makeChainService(internals, "a".repeat(61));
        const twin = new CiaoService(networkManager, { name: "a".repeat(61), port: 4712, type: "http" });
        const nameChanges = jest.fn();

        service.on(ServiceEvent.NAME_CHANGED, nameChanges);
        internals.announcedServices.set(twin.getLowerCasedFQDN(), twin);

        const advertised = track(service.advertise());

        await advance(2000);

        expect(advertised.state).toBe("resolved");
        expect(nameChanges.mock.calls).toEqual([["a".repeat(59) + " (2)"]]);
        expect(service.getFQDN()).toBe("a".repeat(59) + " (2)._http._tcp.local.");
        expect(service.serviceState).toBe(ServiceState.ANNOUNCING);
      });

      // A domain of four 59-octet labels leaves an instance label two octets within the 255 of the FQDN, room for "a" and none for " (2)".
      it("no prefix fits rejects the probe with the service unchanged, and the service queued behind it advertises", async () => {
        const { internals } = makeChainResponder();
        const domain = Array(4).fill("d".repeat(59)).join(".");
        const stuck = makeChainService(internals, "a", { domain }).service;
        const twin = new CiaoService(networkManager, { domain, name: "a", port: 4712, type: "http" });
        const queued = makeChainService(internals, "Queued").service;
        const probe = jest.spyOn(internals, "probe");
        const before = [ stuck.getFQDN(), stuck.getHostname() ];

        internals.announcedServices.set(twin.getLowerCasedFQDN(), twin);

        const advertiseStuck = track(stuck.advertise());
        const advertiseQueued = track(queued.advertise());

        await advance(0);

        const stuckProbe = track(probe.mock.results[0].value);

        await advance(1000);

        expect(stuckProbe.state).toBe("rejected");
        expect(String(stuckProbe.reason)).toContain("The service name 'a' has no prefix that fits with the number ' (2)'");
        expect([ stuck.getFQDN(), stuck.getHostname() ]).toEqual(before);
        expect(stuck.serviceState).toBe(ServiceState.UNANNOUNCED);
        expect(advertiseStuck.state).toBe("pending");
        expect(advertiseQueued.state).toBe("resolved");
        expect(queued.serviceState).toBe(ServiceState.ANNOUNCING);
      });
    });

    /* Node reports an unhandled rejection only after a real turn of the event loop, so this row runs on real timers and ends on one. The listener that
     * reads it is jest-circus's own on the real process, which charges the rejection to the running test and fails it: a listener added through the
     * test's process object never hears the event, as jest hands each test a copy of that object.
     */
    describe("announcement waits of a service", () => {
      const realTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

      beforeEach(() => {
        jest.useRealTimers();
      });

      it("updateTxt() and a network update after the last announcement raise no unhandled rejection when the announcer is then cancelled", async () => {
        const server = makeChainServer();
        const service = new CiaoService(networkManager, { name: "Waiting", port: 4711, type: "http" });
        let announcementReason: unknown = undefined;

        // The one announcement goes out on a bound interface and its send is held, so the announcer has sent its last announcement and is pending.
        server.getBoundInterfaceNames.mockReturnValue(["en0"]);
        server.send.mockImplementation(() => new Promise(() => undefined));
        service.rebuildServiceRecords();
        service.serviceState = ServiceState.ANNOUNCING;

        const announcer = new Announcer(server as unknown as MDNSServer, service, { repetitions: 1 });

        service.currentAnnouncer = announcer;
        // The Responder handles the announcement's own rejection in production, so this row does too and leaves only the waits under test to be read.
        announcer.announce().catch(reason => {
          announcementReason = reason;
        });
        await realTurn();
        expect(announcer.hasSentLastAnnouncement()).toBe(true);

        service.updateTxt({ version: "2" });
        service.handleNetworkInterfaceUpdate({ added: [] });
        await announcer.cancel();
        await realTurn();

        expect(announcementReason).toBe(Announcer.CANCEL_REASON);
      });
    });
  });

  describe("answers to a question on a service's names", () => {
    it("a CNAME question gets no address, SRV or TXT record, while ANY and PTR questions are answered as before", () => {
      const { answer, service } = makeAnsweringResponder({ ipv4: "192.0.2.1", ipv6: "fe80::1" });
      const cnameRecords = [ service.getHostname(), service.getFQDN(), service.getTypePTR() ].flatMap(name => answer(name, QType.CNAME))
        .flatMap(packet => [ ...packet.answers.values(), ...packet.additionals.values() ]);
      const sections = (packets: DNSPacket[]) => packets.map(packet => ({ additionals: typesOf(packet.additionals), answers: typesOf(packet.answers) }));

      expect(cnameRecords.filter(record => [ RType.A, RType.AAAA, RType.SRV, RType.TXT ].includes(record.type))).toEqual([]);
      expect(sections(answer(service.getHostname(), QType.ANY))).toEqual([{ additionals: [RType.NSEC], answers: [ RType.A, RType.AAAA ] }]);
      expect(sections(answer(service.getFQDN(), QType.ANY)))
        .toEqual([{ additionals: [ RType.A, RType.AAAA, RType.NSEC, RType.NSEC ], answers: [ RType.TXT, RType.SRV ] }]);
      expect(sections(answer(service.getTypePTR(), QType.PTR)))
        .toEqual([{ additionals: [ RType.TXT, RType.SRV, RType.A, RType.AAAA, RType.NSEC, RType.NSEC ], answers: [RType.PTR] }]);
    });

    /* RFC 6762 6.1: a name the service owns uniquely answers a question for a type it holds no record of with an NSEC record, its bitmap the types that
     * exist, while the shared type and subtype PTR names answer no such question. MX (15) is a type ciao publishes nothing of.
     */
    const MX = 15 as QType;

    it.each<[string, Partial<NetworkInterface>, QType, RType[]]>([
      ["an AAAA question on an IPv4-only interface", { ipv4: "192.0.2.1" }, QType.AAAA, [RType.A]],
      ["an A question on an IPv6-only interface", { ipv6: "fe80::1" }, QType.A, [RType.AAAA]],
    ])("%s gets one answer, the address NSEC listing the address type the interface carries", (_, addresses, type, listed) => {
      const { answer, service } = makeAnsweringResponder(addresses);
      const packets = answer(service.getHostname(), type);

      expect(packets.map(packet => typesOf(packet.answers))).toEqual([[RType.NSEC]]);
      expect(nsecTypesOf(packets[0].answers, service.getHostname())).toEqual(listed);
    });

    it.each<[string, Partial<NetworkInterface>, RType[]]>([
      ["an interface carrying both address types", { ipv4: "192.0.2.1", ipv6: "fe80::1" }, [ RType.A, RType.AAAA ]],
      ["an IPv4-only interface", { ipv4: "192.0.2.1" }, [RType.A]],
    ])("an MX and a CNAME question on the hostname get the address NSEC as the answer on %s, listing its address types", (_, addresses, listed) => {
      const { answer, service } = makeAnsweringResponder(addresses);

      for (const type of [ MX, QType.CNAME ]) {
        const packets = answer(service.getHostname(), type);

        expect(packets.map(packet => typesOf(packet.answers))).toEqual([[RType.NSEC]]);
        expect(nsecTypesOf(packets[0].answers, service.getHostname())).toEqual(listed);
      }
    });

    it("an MX question on the instance name gets the service NSEC as the answer, listing TXT and SRV", () => {
      const { answer, service } = makeAnsweringResponder({ ipv4: "192.0.2.1", ipv6: "fe80::1" });
      const packets = answer(service.getFQDN(), MX);

      expect(packets.map(packet => typesOf(packet.answers))).toEqual([[RType.NSEC]]);
      expect(nsecTypesOf(packets[0].answers, service.getFQDN())).toEqual([ RType.TXT, RType.SRV ]);
    });

    it("the address NSEC in the additionals of A, AAAA, SRV and PTR answers lists the address types of the asking interface alone", () => {
      const ipv4Only = makeAnsweringResponder({ ipv4: "192.0.2.1" });
      const ipv6Only = makeAnsweringResponder({ ipv6: "fe80::1" });
      const additionalNSEC = (responder: ReturnType<typeof makeAnsweringResponder>, name: string, type: QType) =>
        nsecTypesOf(responder.answer(name, type)[0].additionals, responder.service.getHostname());

      expect(additionalNSEC(ipv4Only, ipv4Only.service.getHostname(), QType.A)).toEqual([RType.A]);
      expect(additionalNSEC(ipv6Only, ipv6Only.service.getHostname(), QType.AAAA)).toEqual([RType.AAAA]);
      expect(additionalNSEC(ipv4Only, ipv4Only.service.getFQDN(), QType.SRV)).toEqual([RType.A]);
      expect(additionalNSEC(ipv6Only, ipv6Only.service.getTypePTR(), QType.PTR)).toEqual([RType.AAAA]);
    });

    // The MDNSServer names an interface's IPv6 socket "<name>/6", and a question asked there is answered from the records of the interface it belongs to.
    it("an ANY question on the hostname asked on en0's IPv6 socket gets the A and AAAA records and an address NSEC listing both", () => {
      const { answer, service } = makeAnsweringResponder({ ipv4: "192.0.2.1", ipv6: "fe80::1" }, "en0/6");
      const packets = answer(service.getHostname(), QType.ANY);

      expect(packets.map(packet => typesOf(packet.answers))).toEqual([[ RType.A, RType.AAAA ]]);
      expect(nsecTypesOf(packets[0].additionals, service.getHostname())).toEqual([ RType.A, RType.AAAA ]);
    });

    it("an MX question on the type PTR name or a subtype PTR name gets no answer", () => {
      const { answer, service } = makeAnsweringResponder({ ipv4: "192.0.2.1", ipv6: "fe80::1" });

      expect(answer(service.getTypePTR(), MX)).toEqual([]);
      expect(answer(service.getLowerCasedSubtypePTRs()![0], MX)).toEqual([]);
    });
  });
});
