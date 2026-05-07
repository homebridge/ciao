import { ServiceState } from "./CiaoService";
import { Responder } from "./Responder";

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
});
