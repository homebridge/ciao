import { ServiceState } from "../CiaoService";
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
});
