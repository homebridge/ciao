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

    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => {
        // keep the expected error out of the test output
      });
    });

    afterEach(() => {
      errorSpy.mockRestore();
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
