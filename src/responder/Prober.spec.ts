import { CiaoService, ServiceOptions, ServiceState } from "../CiaoService";
import { DNSPacket, DNSProbeQueryDefinition, PacketType, QType } from "../coder/DNSPacket";
import { Question } from "../coder/Question";
import { EndpointInfo, MDNSServer, TimedSendResult } from "../MDNSServer";
import { NetworkManager } from "../NetworkManager";
import { Responder } from "../Responder";
import { Prober } from "./Prober";

const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;

/**
 * Enough of a CiaoService for the Prober to build its record set and name its
 * questions. The Prober only reads these, so plain stand-ins are fine.
 */
function fakeService() {
  // The Prober sorts its record set with rrComparator, which reads class, type and
  // the raw rdata off each record - so the stand-ins need those three.
  const record = (type: number) => ({
    flushFlag: true,
    class: 1,
    type,
    getRawData: () => Buffer.from([ type ]),
  });

  return {
    serviceState: ServiceState.PROBING,
    getFQDN: () => "Test._hap._tcp.local.",
    getHostname: () => "Test.local.",
    getLowerCasedFQDN: () => "test._hap._tcp.local.",
    getLowerCasedHostname: () => "test.local.",
    srvRecord: () => record(33),
    txtRecord: () => record(16),
    ptrRecord: () => record(12),
    subtypePtrRecords: () => [],
    allAddressRecords: () => [],
    advertisesOnInterface: () => true,
  };
}

describe(Prober, () => {
  describe("send failure handling", () => {
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => {
        // keep any unexpected error out of the test output
      });
      logSpy = jest.spyOn(console, "log").mockImplementation(() => {
        // as above
      });
      warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {
        // as above
      });
    });

    afterEach(() => {
      errorSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      jest.useRealTimers();
    });

    // Regression: sendQueryBroadcast builds and encodes the packet synchronously, so
    // an oversized probe query throws rather than rejecting. sendProbeRequest runs
    // from a setTimeout callback, so that throw used to escape as an uncaught
    // exception and take the host process down with it. It must fail just the probe.
    it("rejects the probe promise when the query cannot be built", async () => {
      const thrown = new Error("Probe query packet exceeds the mtu size (1600>1440).");
      const server = {
        sendQueryBroadcast: jest.fn(() => {
          throw thrown;
        }),
      };
      const responder = { getAnnouncedServices: () => [] };
      const service = fakeService();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prober = new Prober(responder as any, server as any, service as any);

      jest.useFakeTimers();
      const probing = prober.probe();
      // probe() arms the first query behind a random jitter of up to PROBE_INTERVAL
      jest.advanceTimersByTime(250);

      await expect(probing).rejects.toBe(thrown);
      expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(1);
    });

    // Regression (homebridge/ciao#72): a failing probe is retried every 2 seconds by the
    // Responder, so logging it to the console here put a line out on every attempt,
    // forever. The failure still reaches the caller through the rejected promise, and
    // whatever actually broke is reported by MDNSServer - the console gets nothing.
    it("keeps a failing probe off the console", async () => {
      const server = {
        sendQueryBroadcast: jest.fn(() => {
          throw new Error("Probe query packet exceeds the mtu size (1600>1440).");
        }),
      };
      const responder = { getAnnouncedServices: () => [] };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prober = new Prober(responder as any, server as any, fakeService() as any);

      jest.useFakeTimers();
      const probing = prober.probe();
      probing.catch(() => {
        // the rejection is the caller's channel - asserted in the test above
      });
      jest.advanceTimersByTime(250);
      await Promise.resolve();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not let the throw escape the timer callback", () => {
      const server = {
        sendQueryBroadcast: () => {
          throw new Error("nope");
        },
      };
      const responder = { getAnnouncedServices: () => [] };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prober = new Prober(responder as any, server as any, fakeService() as any);

      jest.useFakeTimers();
      const probing = prober.probe();
      probing.catch(() => {
        // expected - asserted in the test above
      });

      expect(() => jest.advanceTimersByTime(250)).not.toThrow();
    });
  });

  describe("conflicts with services of the same responder (#20)", () => {
    function makeService(options: Partial<ServiceOptions>): CiaoService {
      return new CiaoService(networkManager, { name: "Living Room", type: "http", port: 4711, ...options });
    }

    function hasLocalConflict(announced: CiaoService, probing: CiaoService): boolean {
      const responder = { getAnnouncedServices: () => [ announced ] };
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const prober = new Prober(responder as any, {} as any, probing);
      const handleNameChange = jest.spyOn(prober as any, "handleNameChange").mockImplementation(() => { /* no-op */ });
      (prober as any).checkLocalConflicts();
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return handleNameChange.mock.calls.length > 0;
    }

    it("lets two services of different types keep the same name", () => {
      // both derive the hostname "Living-Room.local." from the name
      expect(hasLocalConflict(makeService({ type: "http" }), makeService({ type: "ipp" }))).toBe(false);
    });

    it("still renames a service whose name and type are taken", () => {
      expect(hasLocalConflict(makeService({}), makeService({ port: 4712 }))).toBe(true);
    });

    it("still renames a service whose hostname is taken with other addresses", () => {
      expect(hasLocalConflict(makeService({ type: "http" }), makeService({ type: "ipp", disabledIpv6: true }))).toBe(true);
    });
  });

  /* A tiebreak lost or a rename taken while a probe query is in flight ends the attempt that query belongs to, and probing starts over one second later:
   * after a lost tiebreak as RFC 6762 section 8.2 sets, and after a rename by the Prober's own back-off, with the renamed records (section 8.1). Each row
   * holds the second query open, because the Prober answers no traffic until its first query has gone out, ends the attempt while that query is held, and
   * reads what the query does once its send resolves.
   */
  describe("an attempt that ends while a probe query is in flight", () => {
    const endpoint: EndpointInfo = { address: "192.168.1.2", interface: "en0", port: 5353 };
    const failedSend: TimedSendResult = { interface: "en0", reason: new Error("The fake server fails this send."), status: "rejected" };

    interface HeldQuery {
      prober: Prober;
      rejection: jest.Mock;
      release: (results: TimedSendResult[]) => void;
      server: { sendQueryBroadcast: jest.Mock<Promise<TimedSendResult[]>, [DNSProbeQueryDefinition, CiaoService]> };
      service: CiaoService;
      twin: CiaoService;
    }

    beforeEach(() => {
      jest.useFakeTimers();
      // The first query goes out at once rather than after its random delay.
      jest.spyOn(Math, "random").mockReturnValue(0);
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    /* Starts a Prober on a service named "Kitchen" over a fake server and runs the clock until the second probe query is out and held open. The twin shares
     * the name on a greater port, so its records win a tiebreak against the service's and its SRV record answers the service's probe.
     */
    async function probingWithSecondQueryHeld(): Promise<HeldQuery> {
      const service = new CiaoService(networkManager, { name: "Kitchen", port: 4711, type: "http" });
      const twin = new CiaoService(networkManager, { name: "Kitchen", port: 4712, type: "http" });
      const rejection = jest.fn();
      const server = {
        sendQueryBroadcast: jest.fn<Promise<TimedSendResult[]>, [DNSProbeQueryDefinition, CiaoService]>(async () => []),
      };
      let release: (results: TimedSendResult[]) => void = () => {
        throw new Error("The Prober sent no second probe query.");
      };

      server.sendQueryBroadcast
        .mockImplementationOnce(async () => [])
        .mockImplementationOnce(() => new Promise(resolve => {
          release = resolve;
        }));

      // The Responder rebuilds a service's records and moves it to PROBING before it hands the service to a Prober.
      service.rebuildServiceRecords();
      twin.rebuildServiceRecords();
      service.serviceState = ServiceState.PROBING;

      const responder = { getAnnouncedServices: () => [] };
      const prober = new Prober(responder as unknown as Responder, server as unknown as MDNSServer, service);

      prober.probe().catch(rejection);

      // The first query resolves at once, and the second goes out a probe interval later.
      await jest.advanceTimersByTimeAsync(250);
      expect(server.sendQueryBroadcast).toHaveBeenCalledTimes(2);

      return { prober, rejection, release, server, service, twin };
    }

    it.each<[string, TimedSendResult[]]>([
      [ "is sent", [] ],
      [ "fails", [failedSend] ],
    ])("a tiebreak lost with the second query held, which then %s, leaves one timer and probes again one second after the loss", async (_outcome, results) => {
      const held = await probingWithSecondQueryHeld();
      const opponentQuery = new DNSPacket({
        authorities: [ held.twin.ptrRecord(), held.twin.txtRecord(), held.twin.srvRecord() ],
        questions: [new Question(held.twin.getFQDN(), QType.ANY, true)],
        type: PacketType.QUERY,
      });

      held.prober.handleQuery(opponentQuery, endpoint);
      expect(jest.getTimerCount()).toBe(1);

      held.release(results);
      await jest.advanceTimersByTimeAsync(0);

      expect(jest.getTimerCount()).toBe(1);
      expect(held.rejection).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(999);
      expect(held.server.sendQueryBroadcast).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(1);
      expect(held.server.sendQueryBroadcast).toHaveBeenCalledTimes(3);
    });

    it("a rename with the second query held leaves one timer, and the next query goes out one second later with the renamed records", async () => {
      const held = await probingWithSecondQueryHeld();

      held.prober.handleResponse(DNSPacket.createDNSResponsePacketsFromRRSet({ answers: [held.twin.srvRecord()] }), endpoint);
      expect(held.service.getFQDN()).toBe("Kitchen (2)._http._tcp.local.");

      held.release([]);
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(1);

      await jest.advanceTimersByTimeAsync(999);
      expect(held.server.sendQueryBroadcast).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(1);

      const probedNames = held.server.sendQueryBroadcast.mock.calls[2][0].authorities?.map(record => record.name);

      expect(probedNames).toContain("Kitchen (2)._http._tcp.local.");
      expect(probedNames).not.toContain("Kitchen._http._tcp.local.");
    });
  });
});
