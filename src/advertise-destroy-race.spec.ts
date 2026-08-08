import { CiaoService, InternalServiceEvent, ServiceState } from "./CiaoService";
import { Responder } from "./Responder";
import { NetworkManager } from "./NetworkManager";
import { Announcer } from "./responder/Announcer";

interface FakeResponderInternal {
  server: {
    sendQueryBroadcast: jest.Mock;
    getBoundInterfaceNames: jest.Mock;
    send: jest.Mock;
  };
  promiseChain: Promise<void>;
  servicePointer: Map<string, string[]>;
  announcedServices: Map<string, CiaoService>;
  getAnnouncedServices: () => IterableIterator<CiaoService>;
  probe?: (service: CiaoService) => Promise<void>;
}

interface FakeResponderFacade {
  advertiseService: (service: CiaoService, callback: (error?: Error | undefined) => void) => Promise<void>;
  unpublishService: (service: CiaoService) => Promise<void>;
}

function makeFakeResponder() {
  const server = {
    sendQueryBroadcast: jest.fn(async () => []),
    getBoundInterfaceNames: jest.fn(() => []),
    send: jest.fn(async () => ({ status: "fulfilled", interface: "en0" })),
  };

  const responder = Object.create(Responder.prototype) as unknown as FakeResponderInternal;
  responder.server = server;
  responder.promiseChain = Promise.resolve();
  responder.servicePointer = new Map();
  responder.announcedServices = new Map();
  responder.getAnnouncedServices = () => responder.announcedServices.values();

  return { responder, server };
}

function makeService(): CiaoService {
  const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
  return new CiaoService(networkManager, {
    name: "Test Service",
    type: "http",
    port: 4711,
  });
}

function wire(responder: Responder | FakeResponderInternal, service: CiaoService): void {
  const responderFacade = responder as unknown as FakeResponderFacade;
  service.on(InternalServiceEvent.PUBLISH, responderFacade.advertiseService.bind(responderFacade, service));
  service.on(InternalServiceEvent.UNPUBLISH, responderFacade.unpublishService.bind(responderFacade, service));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flush();
}

describe("immediate advertise()/destroy() lifecycle race", () => {
  let announceSpy: jest.SpiedFunction<Announcer["announce"]>;
  let randomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    jest.useFakeTimers();
    announceSpy = jest.spyOn(Announcer.prototype, "announce");
    randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    announceSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("does not probe, announce, or retry after a destroy raced before startup", async () => {
    const { responder, server } = makeFakeResponder();
    const service = makeService();
    wire(responder, service);

    const advertisePromise = service.advertise();
    expect(service.serviceState).toBe(ServiceState.UNANNOUNCED);

    await service.destroy();

    for (let i = 0; i < 20; i++) {
      await advance(250);
    }

    expect({
      probeBroadcasts: server.sendQueryBroadcast.mock.calls.length,
      announcements: announceSpy.mock.calls.length,
      serviceState: service.serviceState,
      announcedServices: Array.from(responder.getAnnouncedServices()).length,
    }).toEqual({
      probeBroadcasts: 0,
      announcements: 0,
      serviceState: ServiceState.UNANNOUNCED,
      announcedServices: 0,
    });
    await expect(advertisePromise).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not announce when destroy lands after probing has started", async () => {
    const { responder } = makeFakeResponder();
    const service = makeService();
    wire(responder, service);

    let finishProbe: () => void = () => {
      throw new Error("probe did not start");
    };
    const probePromise = new Promise<void>(resolve => {
      finishProbe = resolve;
    });
    const probe = jest.fn((probingService: CiaoService) => {
      probingService.serviceState = ServiceState.PROBING;
      return probePromise.then(() => {
        probingService.serviceState = ServiceState.PROBED;
      });
    });
    responder.probe = probe;

    const advertisePromise = service.advertise();
    await flush();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(service.serviceState).toBe(ServiceState.PROBING);

    await service.destroy();
    finishProbe();
    await flush();

    await expect(advertisePromise).resolves.toBeUndefined();
    expect(announceSpy).not.toHaveBeenCalled();
    expect(service.serviceState).toBe(ServiceState.UNANNOUNCED);
    expect(Array.from(responder.getAnnouncedServices())).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("survives repeated immediate advertise/destroy races without leftover work", async () => {
    const cycles = 50;

    for (let i = 0; i < cycles; i++) {
      const { responder, server } = makeFakeResponder();
      const service = makeService();
      wire(responder, service);

      const advertisePromise = service.advertise();
      await service.destroy();
      await expect(advertisePromise).resolves.toBeUndefined();

      expect(server.sendQueryBroadcast).not.toHaveBeenCalled();
      expect(service.serviceState).toBe(ServiceState.UNANNOUNCED);
      expect(Array.from(responder.getAnnouncedServices())).toHaveLength(0);
    }

    await advance(5000);
    expect(announceSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps the service usable when shutdown rejects", async () => {
    const service = makeService();
    const shutdownError = new Error("goodbye failed");
    service.serviceState = ServiceState.ANNOUNCED;
    service.on(InternalServiceEvent.UNPUBLISH, callback => callback(shutdownError));

    await expect(service.destroy()).rejects.toThrow(shutdownError);

    expect(service.isDestroyed()).toBe(false);
    expect(service.listenerCount(InternalServiceEvent.UNPUBLISH)).toBe(1);
  });

  it("preserves the existing guard against destroying a service twice", async () => {
    const service = makeService();

    await service.destroy();

    await expect(service.destroy()).rejects.toThrow("Cannot end destroyed service!");
  });
});
