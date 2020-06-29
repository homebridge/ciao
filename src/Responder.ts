import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import {
  CiaoService,
  InternalServiceEvent,
  PublishCallback,
  ServiceOptions,
  ServiceState,
  UnpublishCallback,
} from "./CiaoService";
import { DNSPacket, DNSResponseDefinition, QClass, QType, RType } from "./coder/DNSPacket";
import { Question } from "./coder/Question";
import { NSECRecord } from "./coder/records/NSECRecord";
import { PTRRecord } from "./coder/records/PTRRecord";
import { ResourceRecord } from "./coder/ResourceRecord";
import { EndpointInfo, MDNSServer, MDNSServerOptions, PacketHandler, SendCallback } from "./MDNSServer";
import { Prober } from "./Prober";
import { dnsLowerCase } from "./util/dns-equal";
import { ipAddressFromReversAddressName } from "./util/domain-formatter";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:Responder");

interface CalculatedAnswer {
  answers: ResourceRecord[];
  additionals: ResourceRecord[];
}

const enum TruncatedQueryResult {
  ABORT = 1,
  AGAIN_TRUNCATED = 2,
  FINISHED = 3,
}

const enum TruncatedQueryEvent {
  TIMEOUT = "timeout",
}

declare interface TruncatedQuery {

  on(event: "timeout", listener: () => void): this;

  emit(event: "timeout"): boolean;

}

class TruncatedQuery extends EventEmitter {

  private readonly timeOfArrival: number;
  private readonly packet: DNSPacket;
  private arrivedPackets = 1; // just for the stats

  private timer: Timeout;

  constructor(packet: DNSPacket) {
    super();
    this.timeOfArrival = new Date().getTime();
    this.packet = packet;

    this.timer = this.resetTimer();
  }

  public getPacket(): DNSPacket {
    return this.packet;
  }

  public getArrivedPacketCount(): number {
    return this.arrivedPackets;
  }

  public getTotalWaitTime(): number {
    return new Date().getTime() - this.timeOfArrival;
  }

  public appendDNSPacket(packet: DNSPacket): TruncatedQueryResult {
    this.packet.questions.push(...packet.questions);
    this.packet.answers.push(...packet.answers);
    this.packet.additionals.push(...packet.additionals);
    this.packet.authorities.push(...packet.authorities);

    this.arrivedPackets++;

    if (packet.flags.truncation) { // if the appended packet is again truncated, restart the timeout
      const time = new Date().getTime();

      if (time - this.timeOfArrival > 5 * 1000) { // if the first packet, is more than 5 seconds old, we abort
        return TruncatedQueryResult.ABORT;
      }

      this.resetTimer();
      return TruncatedQueryResult.AGAIN_TRUNCATED;
    } else {
      clearTimeout(this.timer);
      return TruncatedQueryResult.FINISHED;
    }
  }

  private resetTimer(): Timeout {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    // timeout in time interval between 400-500ms
    return this.timer = setTimeout(this.timeout.bind(this), 400 + Math.random() * 100);
  }

  private timeout(): void {
    this.emit(TruncatedQueryEvent.TIMEOUT);
  }

}

class QueryResponse implements DNSResponseDefinition {

  id?: number;
  questions?: Question[];
  answers: ResourceRecord[] = [];
  additionals: ResourceRecord[] = [];
  legacyUnicast?: boolean;

  public addAnswer(...records: ResourceRecord[]): void {
    for (const record of records) {
      const overwritten = QueryResponse.replaceExistingRecord(this.answers, record);

      if (!overwritten) {
        this.answers.push(record);
      }

      QueryResponse.removeAboutSameRecord(this.additionals, record);
    }
  }

  public addAdditional(...records: ResourceRecord[]): void {
    for (const record of records) {
      const overwrittenAnswer = QueryResponse.replaceExistingRecord(this.answers, record);

      // if it is already in the answer section, don't include it in additionals
      if (!overwrittenAnswer) {
        const overwrittenAdditional = QueryResponse.replaceExistingRecord(this.additionals, record);
        if (!overwrittenAdditional) {
          this.additionals.push(record);
        }
      }
    }
  }

  public markLegacyUnicastResponse(id: number, questions: Question[], multicastResponse: QueryResponse): void {
    // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
    //  * MUSTS: response via unicast, repeat query ID, repeat questions (actually it should just be one), clear cache flush bit
    //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism
    this.addAnswer(...multicastResponse.answers);
    this.addAdditional(...multicastResponse.additionals);
    multicastResponse.clear();

    this.id = id;
    this.questions = questions;

    this.answers.forEach(answers => {
      answers.flushFlag = false;
      answers.ttl = 10;
    });
    this.additionals?.forEach(answers => {
      answers.flushFlag = false;
      answers.ttl = 10;
    });

    this.legacyUnicast = true; // legacy unicast also affects the encoder (must not use compression for the SRV record) so we need to tell him
  }

  public hasAnswers(): boolean {
    // we may still have additionals, though there is no reason when answers is empty
    // removeKnownAnswer may have removed all answers and only additionals are known.
    return this.answers.length > 0;
  }

  public removeKnownAnswer(record: ResourceRecord): void {
    QueryResponse.removeKnownAnswers(record, this.answers);
    QueryResponse.removeKnownAnswers(record, this.additionals);
  }

  private clear(): void {
    this.answers.splice(0, this.answers.length);
    this.additionals.splice(0, this.additionals.length);
  }

  private static removeKnownAnswers(knownAnswer: ResourceRecord, records: ResourceRecord[]): void {
    const ids: number[] = []; // ids which get removed

    records.forEach(((record, index) => {
      if (knownAnswer.aboutEqual(record)) {
        // we will still send the response if the known answer has half of the original ttl according to RFC 6762 7.1.
        if (knownAnswer.ttl >= record.ttl / 2) {
          ids.push(index);
        }
      }
    }));

    for (const i of ids) {
      records.splice(i, 1);
    }
  }

  private static replaceExistingRecord(records: ResourceRecord[], record: ResourceRecord): boolean {
    let overwrittenSome = false;

    for (let i = 0; i < records.length; i++) {
      const record0 = records[i];

      if (record0.representsSameData(record)) {
        if (record.flushFlag && (record.type !== RType.A && record.type !== RType.AAAA)) {
          records[i] = record;
          overwrittenSome = true;
          break;
        } else if (record0.dataEquals(record)) {
          // flush flag is not set, but it is the same data thus the SAME record
          record0.ttl = record.ttl;
          overwrittenSome = true;
          break;
        }
      }
    }

    return overwrittenSome;
  }

  private static removeAboutSameRecord(records: ResourceRecord[], record: ResourceRecord): void {
    let i = 0;
    for (; i < records.length; i++) {
      const record0 = records[i];

      if (record0.representsSameData(record)) {
        if ((record.flushFlag && (record.type !== RType.A && record.type !== RType.AAAA)) || record0.dataEquals(record)) {
          break; // we can break, as assumption is that no records does not contain duplicates
        }
      }
    }

    if (i < records.length) {
      records.splice(i, 1);
    }
  }

}

export class Responder implements PacketHandler {

  public static readonly SERVICE_TYPE_ENUMERATION_NAME = "_services._dns-sd._udp.local.";

  private readonly server: MDNSServer;
  private promiseChain: Promise<void>;

  private bound = false;

  // announcedServices is indexed by dnsLowerCase(service.fqdn) (as of RFC 1035 3.1)
  private readonly announcedServices: Map<string, CiaoService> = new Map();
  /*
   * map representing all our shared PTR records.
   * Typically we hold stuff like '_services._dns-sd._udp.local' (RFC 6763 9.), '_hap._tcp.local'.
   * Also pointers for every subtype like '_printer._sub._http._tcp.local' are inserted here.
   *
   * For every pointer we may hold multiple entries (like multiple services can advertise on _hap._tcp.local).
   */
  private readonly servicePointer: Map<string, string[]> = new Map();

  private readonly truncatedQueries: Record<string, TruncatedQuery> = {}; // indexed by <ip>:<port>

  private currentProber?: Prober;

  constructor(options?: MDNSServerOptions) {
    this.server = new MDNSServer(this, options);
    this.promiseChain = this.start();
  }

  public createService(options: ServiceOptions): CiaoService {
    const service = new CiaoService(this.server.getNetworkManager(), options);

    service.on(InternalServiceEvent.PUBLISH, this.advertiseService.bind(this, service));
    service.on(InternalServiceEvent.UNPUBLISH, this.unpublishService.bind(this, service));
    service.on(InternalServiceEvent.RECORD_UPDATE, this.handleServiceRecordUpdate.bind(this, service));

    return service;
  }

  /**
   * This method should be called when you want to unpublish all service exposed by this Responder.
   * This method SHOULD be called before the node application exists, so any host on the
   * network is informed of the shutdown of this machine.
   */
  public shutdown(): Promise<void> {
    debug("Shutting down Responder...");

    const promises: Promise<void>[] = [];
    for (const service of this.announcedServices.values()) {
      promises.push(this.unpublishService(service)); // TODO check if we can combine all those unpublish request into one packet (at least less packets)
    }

    // eslint-disable-next-line
    return Promise.all(promises).then(() => {
      this.server.shutdown();
      this.bound = false;
    });
  }

  private start(): Promise<void> {
    if (this.bound) {
      throw new Error("Server is already bound!");
    }

    this.bound = true;
    return this.server.bind();
  }

  private advertiseService(service: CiaoService, callback: PublishCallback): Promise<void> {
    if (service.serviceState !== ServiceState.UNANNOUNCED) {
      throw new Error("Can't publish a service that is already announced. Received " + service.serviceState + " for service " + service.getFQDN());
    }
    // we have multicast loopback enabled, if there where any conflicting names, they would be resolved by the Prober

    return this.promiseChain = this.promiseChain // we synchronize all ongoing announcements here
      .then(() => this.probe(service))
      .then(() => this.announce(service))
      .then(() => {
        const serviceFQDN = service.getFQDN();
        const typePTR = service.getTypePTR();
        const subtypePTRs = service.getSubtypePTRs(); // possibly undefined

        this.addPTR(Responder.SERVICE_TYPE_ENUMERATION_NAME, typePTR);
        this.addPTR(dnsLowerCase(typePTR), serviceFQDN);
        if (subtypePTRs) {
          for (const ptr of subtypePTRs) {
            this.addPTR(dnsLowerCase(ptr), serviceFQDN);
          }
        }

        this.announcedServices.set(dnsLowerCase(serviceFQDN), service);
        callback();
      }, reason => callback(reason));
  }

  private unpublishService(service: CiaoService, callback?: UnpublishCallback): Promise<void> {
    if (service.serviceState === ServiceState.UNANNOUNCED) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    // TODO we still got some race conditions we we are in the process of sending announcements and this will fail

    if (service.serviceState === ServiceState.ANNOUNCED) {
      debug("[%s] Removing service from the network", service.getFQDN());
      const serviceFQDN = service.getFQDN();
      const typePTR = service.getTypePTR();
      const subtypePTRs = service.getSubtypePTRs(); // possibly undefined

      this.removePTR(Responder.SERVICE_TYPE_ENUMERATION_NAME, typePTR);
      this.removePTR(dnsLowerCase(typePTR), serviceFQDN);
      if (subtypePTRs) {
        for (const ptr of subtypePTRs) {
          this.removePTR(dnsLowerCase(ptr), serviceFQDN);
        }
      }

      this.announcedServices.delete(dnsLowerCase(serviceFQDN));

      service.serviceState = ServiceState.UNANNOUNCED;

      let promise = this.goodbye(service);
      if (callback) {
        promise = promise.then(() => callback(), reason => callback(reason));
      }
      return promise;
    } else if (service.serviceState === ServiceState.PROBING) {
      debug("[%s] Canceling probing", service.getFQDN());
      if (this.currentProber && this.currentProber.getService() === service) {
        this.currentProber.cancel();
        this.currentProber = undefined;
      }

      service.serviceState = ServiceState.UNANNOUNCED;
    }

    return Promise.resolve();
  }

  private addPTR(ptr: string, name: string): void {
    const names = this.servicePointer.get(ptr);
    if (names) {
      if (!names.includes(name)) {
        names.push(name);
      }
    } else {
      this.servicePointer.set(ptr, [name]);
    }
  }

  private removePTR(ptr: string, name: string): void {
    const names = this.servicePointer.get(ptr);

    if (names) {
      const index = names.indexOf(name);
      if (index !== -1) {
        names.splice(index, 1);
      }

      if (names.length === 0) {
        this.servicePointer.delete(ptr);
      }
    }
  }

  private probe(service: CiaoService): Promise<void> {
    if (service.serviceState !== ServiceState.UNANNOUNCED) {
      throw new Error("Can't probe for a service which is announced already. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    service.serviceState = ServiceState.PROBING;

    assert(this.currentProber === undefined, "Tried creating new Prober when there already was one active!");
    this.currentProber = new Prober(this.server, service);
    return this.currentProber.probe()
      .then(() => {
        this.currentProber = undefined;
        service.serviceState = ServiceState.ANNOUNCED; // we consider it announced now
      }, reason => {
        service.serviceState = ServiceState.UNANNOUNCED;
        this.currentProber = undefined;
        throw new Error("Failed probing for " + service.getFQDN() +": " + reason);
      });
  }

  private announce(service: CiaoService): Promise<void> {
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Cannot announce service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Announcing service", service.getFQDN());

    // could happen that the txt record was updated while probing.
    // just to be sure to announce all the latest data, we will rebuild the services.
    service.rebuildServiceRecords();

    const records: ResourceRecord[] = [
      service.ptrRecord(), ...service.subtypePtrRecords(),
      service.srvRecord(), service.txtRecord(),
      // A and AAAA records are added below when sending. Which records get added depends on the network the announcement happens for
    ];

    if (this.announcedServices.size === 0) {
      records.push(service.metaQueryPtrRecord());
    }

    return new Promise((resolve, reject) => {
      // minimum required is to send two unsolicited responses, one second apart
      // we could announce up to 8 times in total (time between messages must increase by two every message)

      // TODO we may want to also announce our revers mapping records?
      this.sendResponseAddingAddressRecords(service, records, false, error => {
        if (error) {
          service.serviceState = ServiceState.UNANNOUNCED;
          reject(error);
          return;
        }

        setTimeout(() => {
          // TODO fix race condition when canceling the announcement. See unpublishService method

          this.sendResponseAddingAddressRecords(service, records, false, error => {
            if (error) {
              service.serviceState = ServiceState.UNANNOUNCED;
              reject(error);
            } else {
              resolve();
            }
          });
        }, 1000).unref();
      });
    });
  }

  private handleServiceRecordUpdate(service: CiaoService, records: ResourceRecord[], callback?: (error?: Error | null) => void): void {
    // when updating we just repeat the announce step
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Updating %d record(s) for given service!", service.getFQDN(), records.length);

    this.server.sendResponseBroadcast( { answers: records }, callback);
  }

  private goodbye(service: CiaoService, recordOverride?: ResourceRecord[]): Promise<void> {
    const records: ResourceRecord[] = recordOverride || [
      service.ptrRecord(), ...service.subtypePtrRecords(),
      service.srvRecord(), service.txtRecord(),
    ];

    records.forEach(answer => answer.ttl = 0); // setting ttl to zero to indicate "goodbye"

    return new Promise((resolve, reject) => {
      this.sendResponseAddingAddressRecords(service, records, true, error => error? reject(error): resolve());
    });
  }

  handleQuery(packet: DNSPacket, endpoint: EndpointInfo): void {
    const endpointId = endpoint.address + ":" + endpoint.port; // used to match truncated queries
    // TODO remove: debug("Incoming query on " + JSON.stringify(endpointId));

    const previousQuery = this.truncatedQueries[endpointId];
    if (previousQuery) {
      const truncatedQueryResult = previousQuery.appendDNSPacket(packet);

      switch (truncatedQueryResult) {
        case TruncatedQueryResult.ABORT: // returned when we detect, that continuously TC queries are sent
          debug("[%s] Aborting to wait for more truncated queries. Waited a total of %d ms receiving %d queries",
            endpointId, previousQuery.getTotalWaitTime(), previousQuery.getArrivedPacketCount());
          return;
        case TruncatedQueryResult.AGAIN_TRUNCATED:
          debug("[%s] Received a query marked as truncated, waiting for more to arrive", endpointId);
          return; // wait for the next packet
        case TruncatedQueryResult.FINISHED:
          delete this.truncatedQueries[endpointId];
          packet = previousQuery.getPacket(); // replace packet with the complete deal

          debug("[%s] Last part of the truncated query arrived. Received %d packets taking a total of %d ms",
            endpointId, previousQuery.getArrivedPacketCount(), previousQuery.getTotalWaitTime());
          break;
      }
    } else if (packet.flags.truncation) {
      // RFC 6763 18.5 truncate flag indicates that additional known-answer records follow shortly
      const truncatedQuery = new TruncatedQuery(packet);
      this.truncatedQueries[endpointId] = truncatedQuery;
      truncatedQuery.on(TruncatedQueryEvent.TIMEOUT, () => {
        // called when more than 400-500ms pass until the next packet arrives
        debug("[%s] Timeout passed since the last truncated query was received. Discarding %d packets received in %d ms.",
          endpointId, truncatedQuery.getArrivedPacketCount(), truncatedQuery.getTotalWaitTime());
        delete this.truncatedQueries[endpointId];
      });

    }

    // responses must not include questions RFC 6762 6.
    const multicastResponse = new QueryResponse();
    const unicastResponse = new QueryResponse();

    // gather answers for all the questions
    packet.questions.forEach(question => {
      const answer = this.answerQuestion(question, endpoint);

      if (question.unicastResponseFlag) { // question requests unicast response
        unicastResponse.addAnswer(...answer.answers);
        unicastResponse.addAdditional(...answer.additionals);
      } else {
        multicastResponse.addAnswer(...answer.answers);
        multicastResponse.addAdditional(...answer.additionals);
      }
    });

    if (this.currentProber) {
      this.currentProber.handleQuery(packet);
    }

    // do known answer suppression according to RFC 6762 7.1.
    packet.answers.forEach(record => {
      unicastResponse.removeKnownAnswer(record);
      multicastResponse.removeKnownAnswer(record);
    });

    if (endpoint.port !== MDNSServer.MDNS_PORT) {
      // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
      //  * MUSTS: response via unicast, repeat query ID, repeat questions, clear cache flush bit
      //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism
      unicastResponse.markLegacyUnicastResponse(packet.id, packet.questions, multicastResponse);
    }

    // TODO duplicate answer suppression 7.4 (especially for the meta query)

    // TODO for query messages containing more than one question, all
    //    (non-defensive) answers SHOULD be randomly delayed in the range
    //    20-120 ms, or 400-500 ms if the TC (truncated) bit is set.  This is
    //    because when a query message contains more than one question, a
    //    Multicast DNS responder cannot generally be certain that other
    //    responders will not also be simultaneously generating answers to
    //    other questions in that query message.  (Answers defending a name, in
    //    response to a probe for that name, are not subject to this delay rule
    //    and are still sent immediately.) => I don't think this is needed?

    // TODO randomly delay the response to avoid collisions (even for unicast responses)
    if (unicastResponse.hasAnswers()) {
      // TODO remove
      debug("Sending response to " + JSON.stringify(endpoint) + " via unicast with "
        + unicastResponse.answers.length + " answers and " + unicastResponse.additionals.length + " additionals");
      this.server.sendResponse(unicastResponse, endpoint);
    }
    if (multicastResponse.hasAnswers()) {
      // TODO To protect the network against excessive packet flooding due to
      //    software bugs or malicious attack, a Multicast DNS responder MUST NOT
      //    (except in the one special case of answering probe queries) multicast
      //    a record on a given interface until at least one second has elapsed
      //    since the last time that record was multicast on that particular
      //    interface.

      // TODO remove
      debug("Sending response via multicast on network " + endpoint.network + " with "
        + multicastResponse.answers.map(answer => answer.type).join(";") + " answers and " + multicastResponse.additionals.map(answer => answer.type).join(";") + " additionals");
      this.server.sendResponse(multicastResponse, endpoint.network);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleResponse(packet: DNSPacket, endpoint: EndpointInfo): void {
    // any questions in a response must be ignored RFC 6762 6.

    if (this.currentProber) { // if there is a probing process running currently, just forward all messages to it
      this.currentProber.handleResponse(packet);
    }

    // TODO conflict resolution if we detect a response with shares name, rrtype and rrclass but rdata is DIFFERENT!
    //  if identical: If the TTL of B's resource record given in the message is less
    //         than half the true TTL from A's point of view, then A MUST mark
    //         its record to be announced via multicast.  Queriers receiving
    //         the record from B would use the TTL given by B and, hence, may
    //         delete the record sooner than A expects.  By sending its own
    //         multicast response correcting the TTL, A ensures that the record
    //         will be retained for the desired time.
  }

  private answerQuestion(question: Question, endpoint: EndpointInfo): CalculatedAnswer {
    const answers: ResourceRecord[] = [];
    const additionals: ResourceRecord[] = [];

    const collectedAnswers: CalculatedAnswer[] = [];

    // RFC 6762 6: The determination of whether a given record answers a given question
    //    is made using the standard DNS rules: the record name must match the
    //    question name, the record rrtype must match the question qtype unless
    //    the qtype is "ANY" (255) or the rrtype is "CNAME" (5), and the record
    //    rrclass must match the question qclass unless the qclass is "ANY" (255).

    if (question.class !== QClass.IN && question.class !== QClass.ANY) {
      // We just publish answers with IN class. So only IN or ANY questions classes will match
      return {
        answers: answers,
        additionals: [],
      };
    }

    switch (question.type) {
      case QType.PTR: {
        const loweredQuestionName = dnsLowerCase(question.name);
        const destinations = this.servicePointer.get(loweredQuestionName); // look up the pointer

        if (destinations) {
          for (const data of destinations) {
            // check if the PTR is pointing towards a service, like in questions for PTR '_hap._tcp.local'
            const service = this.announcedServices.get(dnsLowerCase(data));

            if (service) {
              // call the method so additionals get added properly
              collectedAnswers.push(Responder.answerServiceQuestion(service, question, endpoint));
            } else {
              // it's probably question for PTR '_services._dns-sd._udp.local'
              // the PTR will just point to something like '_hap._tcp.local' thus no additional records need to be included
              answers.push(new PTRRecord(question.name, data));
            }
          }
        } else if (loweredQuestionName.endsWith(".in-addr.arpa") || loweredQuestionName.endsWith(".ip6.arpa")) { // reverse address lookup
          const address = ipAddressFromReversAddressName(loweredQuestionName);

          for (const service of this.announcedServices.values()) {
            const record = service.reverseAddressMapping(address);
            if (record) {
              answers.push(record);
            }
          }
        }
        break;
      }
      default:
        for (const service of this.announcedServices.values()) {
          const serviceAnswer = Responder.answerServiceQuestion(service, question, endpoint);
          collectedAnswers.push(serviceAnswer);
        }
        break;
    }

    for (const answer of collectedAnswers) {
      answers.push(...answer.answers);
      additionals.push(...answer.additionals);
    }

    return {
      answers: answers,
      additionals: additionals,
    };
  }

  private static answerServiceQuestion(service: CiaoService, question: Question, endpoint: EndpointInfo): CalculatedAnswer {
    // This assumes to be called from answerQuestion inside the Responder class and thus that certain
    // preconditions or special cases are already covered.
    // For one we assume classes are already matched.

    const answers: ResourceRecord[] = [];
    const additionals: ResourceRecord[] = [];

    const questionName = dnsLowerCase(question.name);
    const askingAny = question.type === QType.ANY || question.type === QType.CNAME;

    // RFC 6762 6.2. In the event that a device has only IPv4 addresses but no IPv6
    //    addresses, or vice versa, then the appropriate NSEC record SHOULD be
    //    placed into the additional section, so that queriers can know with
    //    certainty that the device has no addresses of that kind.
    const nsecTypes: RType[] = []; // collect types for a negative response

    if (questionName === dnsLowerCase(service.getTypePTR())) {
      if (askingAny || question.type === QType.PTR) {
        answers.push(service.ptrRecord());

        // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
        additionals.push(service.srvRecord(), service.txtRecord());
        Responder.addAddressRecords(service, endpoint, additionals, additionals, nsecTypes);
      }
    } else if (questionName === dnsLowerCase(service.getFQDN())) {
      if (askingAny) {
        answers.push(service.srvRecord(), service.txtRecord());

        // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
        Responder.addAddressRecords(service, endpoint, additionals, additionals, nsecTypes);
      } else if (question.type === QType.SRV) {
        answers.push(service.srvRecord());

        // RFC 6763 12.2: include additionals: a, aaaa
        Responder.addAddressRecords(service, endpoint, additionals, additionals, nsecTypes);
      } else if (question.type === QType.TXT) {
        answers.push(service.txtRecord());

        // RFC 6763 12.3: no not any other additionals
      }
    } else if (questionName === dnsLowerCase(service.getHostname())) {
      if (askingAny) {
        Responder.addAddressRecords(service, endpoint, answers, answers, nsecTypes);
      } else if (question.type === QType.A) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        Responder.addAddressRecords(service, endpoint, answers, additionals, nsecTypes);
      } else if (question.type === QType.AAAA) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        Responder.addAddressRecords(service, endpoint, additionals, answers, nsecTypes);
      }
    } else if (service.getSubtypePTRs()) {
      if (askingAny || question.type === QType.PTR) {
        const dnsLowerSubTypes = service.getSubtypePTRs()!.map(dnsLowerCase);
        const index = dnsLowerSubTypes.indexOf(questionName);

        if (index !== -1) { // we have a sub type for the question
          const records = service.subtypePtrRecords();
          const record = records![index];
          assert(questionName === dnsLowerCase(record.name), "Question Name didn't match selected sub type ptr record!");
          answers.push(record);

          additionals.push(service.srvRecord(), service.txtRecord());
          Responder.addAddressRecords(service, endpoint, additionals, additionals, nsecTypes);
        }
      }
    }

    if (nsecTypes.length > 0) {
      additionals.push(new NSECRecord(service.getHostname(), service.getHostname(), nsecTypes));
    }

    return {
      answers: answers,
      additionals: additionals,
    };
  }

  /**
   * This method is a helper method to reduce the complexity inside {@link answerServiceQuestion}.
   * This method is a bit ugly and complex how it does it's job. Consider it to act like a macro.
   * The method calculates which A and AAAA records to be added for a given {@code endpoint} using
   * the records from the provided {@code service}.
   * It will push the A record onto the aDest array and all AAAA records onto the aaaaDest array.
   * The last argument is the array of negative response types. If a record for a given type (A or AAAA)
   * is not present the type will be added to this array.
   *
   * @param {CiaoService} service - service which records to be use
   * @param {EndpointInfo} endpoint - endpoint information providing the interface
   * @param {ResourceRecord[]} aDest - array where the A record gets added
   * @param {ResourceRecord[]} aaaaDest - array where all AAAA records get added
   * @param {RType[]} nsecDest - if A or AAAA do not exist the type will be pushed onto this array
   */
  private static addAddressRecords(service: CiaoService, endpoint: EndpointInfo, aDest: ResourceRecord[], aaaaDest: ResourceRecord[], nsecDest: RType[]): void {
    const aRecords = service.aRecord(endpoint.network);
    const aaaaRecords = service.aaaaRecords(endpoint.network);

    if (aRecords) {
      aDest.push(...aRecords);
    } else {
      nsecDest.push(RType.A);
    }

    if (aaaaRecords && aaaaRecords.length > 0) {
      aaaaDest.push(...aaaaRecords);
    } else {
      nsecDest.push(RType.AAAA);
    }
  }

  private sendResponseAddingAddressRecords(service: CiaoService, records: ResourceRecord[], goodbye: boolean, callback?: SendCallback): void {
    let iterations = this.server.getNetworkCount();
    const encounteredErrors: Error[] = [];

    for (const id of this.server.getNetworkIds()) {
      const answer: ResourceRecord[] = records.concat([]);

      const aRecords = service.aRecord(id);
      const aaaaRecords = service.aaaaRecords(id);

      if (aRecords) {
        if (goodbye) {
          aRecords.forEach(record => record.ttl = 0);
        }
        answer.push(...aRecords);
      }
      if (aaaaRecords) {
        if (goodbye) {
          aaaaRecords.forEach(record => record.ttl = 0);
        }
        answer.push(...aaaaRecords);
      }

      if (!callback) {
        this.server.sendResponse({ answers: answer }, id);
      } else {
        this.server.sendResponse({ answers: answer }, id, error => {
          if (error) {
            encounteredErrors.push(error);
          }

          if (--iterations <= 0) {
            if (encounteredErrors.length > 0) {
              callback(new Error("Socket errors: " + encounteredErrors.map(error => error.stack).join(";")));
            } else {
              callback();
            }
          }
        });
      }
    }
  }

}
