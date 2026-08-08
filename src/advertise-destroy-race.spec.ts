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

  it("preserves the existing guard against destroying a service twice", async () => {
    const service = makeService();

    await service.destroy();

    await expect(service.destroy()).rejects.toThrow("Cannot end destroyed service!");
  });
});
