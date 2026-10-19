import { CiaoService, ServiceOptions, ServiceState } from "../CiaoService";
import { NetworkManager } from "../NetworkManager";
import { Prober } from "./Prober";

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
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
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
});
