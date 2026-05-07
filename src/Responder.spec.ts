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
});
