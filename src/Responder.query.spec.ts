import { CiaoService } from "./CiaoService";
import { DNSPacket, PacketType, QClass, QType, RType } from "./coder/DNSPacket";
import { Question } from "./coder/Question";
import { ResourceRecord } from "./coder/ResourceRecord";
import { EndpointInfo, MDNSServer } from "./MDNSServer";
import { NetworkInterface, NetworkManager } from "./NetworkManager";
import { Responder } from "./Responder";
import { InterfaceNotFoundError } from "./util/errors";

/* How the Responder sends its answers to a query (RFC 6762 6.): at once or after a random delay, by multicast or by unicast, alone or merged with an answer
 * already waiting. The Responder is built without its constructor, which would bind sockets, around a server that records what it is asked to send, and it
 * holds one announced service, "Kitchen", with an IPv4 address on en0.
 */

type SentResponse = [ packet: DNSPacket, destination: EndpointInfo | string ];

interface QueryResponder {
  handleQuery(packet: DNSPacket, endpoint: EndpointInfo): void;
}

const multicastQuerier: EndpointInfo = { address: "192.0.2.9", interface: "en0", port: MDNSServer.MDNS_PORT };
const legacyQuerier: EndpointInfo = { address: "192.0.2.9", interface: "en0", port: 49152 };

function makeQueryResponder(): { responder: QueryResponder; sent: SentResponse[]; service: CiaoService } {
  const en0: NetworkInterface = { name: "en0", loopback: false, mac: "00:00:5e:00:53:01", ipv4: "192.0.2.5" };
  const manager = { getInterfaceMap: () => new Map([[ en0.name, en0 ]]) } as unknown as NetworkManager;
  const service = new CiaoService(manager, { name: "Kitchen", port: 4711, txt: { a: "1" }, type: "hap" });
  const sent: SentResponse[] = [];
  const responder = Object.create(Responder.prototype) as Responder;

  service.rebuildServiceRecords();

  Object.assign(responder, {
    announcedServices: new Map([[ service.getLowerCasedFQDN(), service ]]),
    currentProber: undefined,
    delayedMulticastResponses: [],
    ignoreUnicastResponseFlag: undefined,
    server: { sendResponse: (packet: DNSPacket, destination: EndpointInfo | string) => sent.push([ packet, destination ]) },
    servicePointer: new Map([
      [ Responder.SERVICE_TYPE_ENUMERATION_NAME, [service.getLowerCasedTypePTR()] ],
      [ service.getLowerCasedTypePTR(), [service.getLowerCasedFQDN()] ],
    ]),
    truncatedQueries: new Map(),
  });

  return { responder: responder as unknown as QueryResponder, sent, service };
}

function query(questions: Question[], knownAnswers: ResourceRecord[] = [], truncated = false): DNSPacket {
  return new DNSPacket({ answers: knownAnswers, flags: truncated? { truncation: true }: {}, id: 0x1234, questions, type: PacketType.QUERY });
}

// The types of a section's records, in the order the packet holds them.
function typesOf(records: Map<string, ResourceRecord>): RType[] {
  return [...records.values()].map(record => record.type);
}

describe("Responder.handleQuery", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Every random delay is its shortest: 20 ms for a delayed response.
    jest.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("answers a question for a record it alone holds at once, by multicast on the interface asked on", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(service.getFQDN(), QType.SRV)]), multicastQuerier);

    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe("en0");
    expect(typesOf(sent[0][0].answers)).toEqual([RType.SRV]);
    expect(sent[0][0].id).toBe(0);
    expect(sent[0][0].questions.size).toBe(0);
  });

  it("delays the answer to a question for a shared record by 20 to 120 ms", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)]), multicastQuerier);
    expect(sent).toHaveLength(0);

    jest.advanceTimersByTime(19);
    expect(sent).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe("en0");
    expect(typesOf(sent[0][0].answers)).toEqual([RType.PTR]);
    // RFC 6763 12.1: the SRV, TXT and address records follow the PTR as additionals.
    expect(typesOf(sent[0][0].additionals)).toEqual(expect.arrayContaining([ RType.SRV, RType.TXT, RType.A ]));
  });

  it("delays the answers to a query with more than one question, even when each record is uniquely held", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([ new Question(service.getFQDN(), QType.SRV), new Question(service.getFQDN(), QType.TXT) ]), multicastQuerier);
    expect(sent).toHaveLength(0);

    jest.advanceTimersByTime(20);
    expect(sent).toHaveLength(1);
    expect(typesOf(sent[0][0].answers).sort()).toEqual([ RType.TXT, RType.SRV ].sort());
  });

  it("answers a probe query at once, whatever it asks", () => {
    const { responder, sent, service } = makeQueryResponder();
    const probe = new DNSPacket({ authorities: [service.srvRecord()], questions: [new Question(service.getTypePTR(), QType.PTR)], type: PacketType.QUERY });

    responder.handleQuery(probe, multicastQuerier);
    expect(sent).toHaveLength(1);
  });

  it("merges two delayed answers for one interface into a single packet", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)]), multicastQuerier);
    responder.handleQuery(query([new Question(Responder.SERVICE_TYPE_ENUMERATION_NAME, QType.PTR)]), multicastQuerier);

    jest.advanceTimersByTime(200);
    expect(sent).toHaveLength(1);
    expect([...sent[0][0].answers.values()].map(record => record.name).sort()).toEqual([ "_hap._tcp.local.", "_services._dns-sd._udp.local." ]);
  });

  it("sends a unique answer with a delayed answer already waiting for that interface, where both fit one packet", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(Responder.SERVICE_TYPE_ENUMERATION_NAME, QType.PTR)]), multicastQuerier);
    responder.handleQuery(query([new Question(service.getFQDN(), QType.TXT)]), multicastQuerier);
    expect(sent).toHaveLength(0);

    jest.advanceTimersByTime(20);
    expect(sent).toHaveLength(1);
    expect(typesOf(sent[0][0].answers).sort()).toEqual([ RType.PTR, RType.TXT ].sort());
  });

  it("leaves out an answer the query lists as known, and sends nothing when every answer is known", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)], [service.ptrRecord()]), multicastQuerier);
    jest.advanceTimersByTime(200);

    expect(sent).toHaveLength(0);
  });

  it("answers a question asking for a unicast response to the querier's address, at once", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR, true)]), multicastQuerier);

    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe(multicastQuerier);
    // A unicast response to a multicast querier keeps the id zero, the cache-flush bits and the full ttl.
    expect(sent[0][0].id).toBe(0);
    expect([...sent[0][0].answers.values()][0].ttl).toBe(4500);
  });

  it("answers a legacy unicast query (RFC 6762 6.7) to its source port, with the id and question repeated, a ttl of 10 and no cache-flush bit", () => {
    const { responder, sent, service } = makeQueryResponder();

    responder.handleQuery(query([new Question(service.getFQDN(), QType.SRV)]), legacyQuerier);

    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe(legacyQuerier);

    const packet = sent[0][0];
    const records = [ ...packet.answers.values(), ...packet.additionals.values() ];

    expect(packet.id).toBe(0x1234);
    expect([...packet.questions.values()].map(question => question.name)).toEqual([service.getFQDN()]);
    expect(packet.legacyUnicastEncodingEnabled()).toBe(true);
    expect(records.length).toBeGreaterThan(1);
    expect(records.every(record => record.ttl === 10 && !record.flushFlag)).toBe(true);
  });

  it("answers no question of another class than IN or ANY", () => {
    const { responder, sent, service } = makeQueryResponder();

    // Class 3 is CH (Chaos), which a decoded question may carry though ciao names no such class.
    responder.handleQuery(query([new Question(service.getFQDN(), QType.SRV, false, 3 as QClass)]), multicastQuerier);
    jest.advanceTimersByTime(200);

    expect(sent).toHaveLength(0);
  });

  describe("a query sent in several packets (RFC 6762 7.2)", () => {
    it("waits for the last packet, and reads the known answers of every packet", () => {
      const { responder, sent, service } = makeQueryResponder();

      responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)], [], true), multicastQuerier);
      jest.advanceTimersByTime(200);
      expect(sent).toHaveLength(0);

      // The second packet carries no question, only the known answer the first had no room for.
      responder.handleQuery(query([], [service.ptrRecord()]), multicastQuerier);
      jest.advanceTimersByTime(200);
      expect(sent).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("answers the question once the last packet arrives without the answer among its known answers", () => {
      const { responder, sent, service } = makeQueryResponder();

      responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)], [], true), multicastQuerier);
      responder.handleQuery(query([], [service.txtRecord()]), multicastQuerier);
      jest.advanceTimersByTime(200);

      expect(sent).toHaveLength(1);
      expect(typesOf(sent[0][0].answers)).toEqual([RType.PTR]);
      // The TXT record the querier knows is left out of the additionals.
      expect(typesOf(sent[0][0].additionals)).not.toContain(RType.TXT);
    });

    it("answers a truncated query with what arrived when its next packet does not come within half a second", () => {
      const { responder, sent, service } = makeQueryResponder();

      responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)], [], true), multicastQuerier);
      jest.advanceTimersByTime(399);
      expect(sent).toHaveLength(0);

      // The wait is 400 ms with Math.random at zero, then 20 ms for the delayed answer of a shared record.
      jest.advanceTimersByTime(21);
      expect(sent).toHaveLength(1);
      expect(typesOf(sent[0][0].answers)).toEqual([RType.PTR]);

      // A packet arriving now starts a query of its own, and it carries no question to answer.
      responder.handleQuery(query([], [service.txtRecord()]), multicastQuerier);
      jest.advanceTimersByTime(200);
      expect(sent).toHaveLength(1);
    });

    it("leaves out the answers a timed-out truncated query listed as known", () => {
      const { responder, sent, service } = makeQueryResponder();

      responder.handleQuery(query([new Question(service.getTypePTR(), QType.PTR)], [service.ptrRecord()], true), multicastQuerier);
      jest.advanceTimersByTime(1000);

      expect(sent).toHaveLength(0);
    });

    it("drops the answer of a timed-out truncated query, without throwing out of the timer, when its interface has gone", () => {
      const { responder, service } = makeQueryResponder();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      // The interface went away while the query waited for its next packet, so its socket is gone, and the send throws as MDNSServer.send does.
      (responder as unknown as { server: { sendResponse: () => void } }).server.sendResponse = () => {
        throw new InterfaceNotFoundError("Could not find socket for given network interface 'en0'");
      };

      // An SRV record is unique, so its answer goes out at once, from the timer of the truncated query.
      responder.handleQuery(query([new Question(service.getFQDN(), QType.SRV)], [], true), multicastQuerier);

      expect(() => jest.advanceTimersByTime(500)).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    });

    it("logs any other error answering a timed-out truncated query, without throwing out of the timer", () => {
      const { responder, service } = makeQueryResponder();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      (responder as unknown as { server: { sendResponse: () => void } }).server.sendResponse = () => {
        throw new Error("encode failed");
      };

      responder.handleQuery(query([new Question(service.getFQDN(), QType.SRV)], [], true), multicastQuerier);

      expect(() => jest.advanceTimersByTime(500)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("encode failed");
    });
  });
});
