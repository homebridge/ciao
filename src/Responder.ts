import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import {
  CiaoService,
  InternalServiceEvent,
  PublishCallback,
  RecordsUpdateCallback,
  ServiceOptions,
  ServiceState,
  UnpublishCallback,
} from "./CiaoService";
import { DNSPacket, DNSResponseDefinition, dnsTypeToString, QClass, QType, RType } from "./coder/DNSPacket";
import { Question } from "./coder/Question";
import { PTRRecord } from "./coder/records/PTRRecord";
import { ResourceRecord } from "./coder/ResourceRecord";
import { EndpointInfo, MDNSServer, MDNSServerOptions, PacketHandler, SendCallback } from "./MDNSServer";
import { InterfaceName } from "./NetworkManager";
import { Prober } from "./Prober";
import { dnsLowerCase } from "./util/dns-equal";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:Responder");

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

type RecordAddMethod = (...records: ResourceRecord[]) => boolean;

class QueryResponse implements DNSResponseDefinition {

  id?: number;
  questions?: Question[];
  answers: ResourceRecord[] = [];
  additionals: ResourceRecord[] = [];
  legacyUnicast?: boolean;

  private knownAnswers?: ResourceRecord[];

  public defineKnownAnswers(records: ResourceRecord[]): void {
    this.knownAnswers = records;
  }

  public addAnswer(...records: ResourceRecord[]): boolean {
    let addedAny = false;

    for (const record of records) {
      const overwritten = QueryResponse.replaceExistingRecord(this.answers, record);

      if (!overwritten) {
        // check if the record to be added is not a known answer
        if (!this.isKnownAnswer(record)) {
          this.answers.push(record);
          addedAny = true;
        }
      } else {
        addedAny = true;
      }

      QueryResponse.removeAboutSameRecord(this.additionals, record);
    }

    return addedAny;
  }

  public addAdditional(...records: ResourceRecord[]): boolean {
    let addedAny = false;

    for (const record of records) {
      const overwrittenAnswer = QueryResponse.replaceExistingRecord(this.answers, record);

      // if it is already in the answer section, don't include it in additionals
      if (!overwrittenAnswer) {
        const overwrittenAdditional = QueryResponse.replaceExistingRecord(this.additionals, record);
        if (!overwrittenAdditional) {
          // check if the additional record is a known answer, otherwise there is no need to send it
          if (!this.isKnownAnswer(record)) {
            this.additionals.push(record);
            addedAny = true;
          }
        } else {
          addedAny = true;
        }
      } else {
        addedAny = true;
      }
    }

    return addedAny;
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

  private clear(): void {
    this.answers.splice(0, this.answers.length);
    this.additionals.splice(0, this.additionals.length);
  }

  private isKnownAnswer(record: ResourceRecord): boolean {
    if (!this.knownAnswers) {
      return false;
    }

    for (const knownAnswer of this.knownAnswers) {
      if (knownAnswer.aboutEqual(record)) {
        // we will still send the response if the known answer has half of the original ttl according to RFC 6762 7.1.
        // so only if the ttl is more than half than the original ttl we consider it a valid known answer
        if (knownAnswer.ttl >= record.ttl / 2) {
          return true;
        }
      }
    }

    return false;
  }

  private static replaceExistingRecord(records: ResourceRecord[], record: ResourceRecord): boolean {
    let overwrittenSome = false;

    for (let i = 0; i < records.length; i++) {
      const record0 = records[i];

      if (record0.representsSameData(record)) {
        // A and AAAA records can be duplicate in one packet even though flush flag is set
        if (record.flushFlag && record.type !== RType.A && record.type !== RType.AAAA) {
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
        // A and AAAA records can be duplicate in one packet even though flush flag is set
        if ((record.flushFlag && record.type !== RType.A && record.type !== RType.AAAA)
          || record0.dataEquals(record)) {
          break; // we can break, as assumption is that no equal records follow (does not contain duplicates)
        }
      }
    }

    if (i < records.length) {
      records.splice(i, 1);
    }
  }

}

/**
 * A Responder instance represents a running MDNSServer and a set of advertised services.
 *
 * It will handle any service related operations, like advertising, sending goodbye packets or sending record updates.
 * It handles answering questions arriving on the multicast address.
 */
export class Responder implements PacketHandler {

  /**
   * @internal
   */
  public static readonly SERVICE_TYPE_ENUMERATION_NAME = "_services._dns-sd._udp.local.";

  private static readonly INSTANCES: Map<string, Responder> = new Map();

  private readonly server: MDNSServer;
  private promiseChain: Promise<void>;

  private refCount = 1;
  private optionsString = "";
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

  /**
   * Refer to {@link getResponder} in the index file
   *
   * @internal should not be used directly. Please use the getResponder method defined in index file.
   */
  public static getResponder(options?: MDNSServerOptions): Responder {
    const optionsString = options? JSON.stringify(options): "";

    const responder = this.INSTANCES.get(optionsString);
    if (responder) {
      responder.refCount++;
      return responder;
    } else {
      const responder = new Responder(options);
      this.INSTANCES.set(optionsString, responder);
      responder.optionsString = optionsString;
      return responder;
    }
  }

  private constructor(options?: MDNSServerOptions) {
    this.server = new MDNSServer(this, options);
    this.promiseChain = this.start();
  }

  /**
   * Creates a new CiaoService instance and links it to this Responder instance.
   *
   * @param {ServiceOptions} options - Defines all information about the service which should be created.
   * @returns The newly created {@link CiaoService} instance can be used to advertise and manage the created service.
   */
  public createService(options: ServiceOptions): CiaoService {
    const service = new CiaoService(this.server.getNetworkManager(), options);

    service.on(InternalServiceEvent.PUBLISH, this.advertiseService.bind(this, service));
    service.on(InternalServiceEvent.UNPUBLISH, this.unpublishService.bind(this, service));
    service.on(InternalServiceEvent.REPUBLISH, this.republishService.bind(this, service));
    service.on(InternalServiceEvent.RECORD_UPDATE, this.handleServiceRecordUpdate.bind(this, service));
    service.on(InternalServiceEvent.RECORD_UPDATE_ON_INTERFACE, this.handleServiceRecordUpdateOnInterface.bind(this, service));

    return service;
  }

  /**
   * This method should be called when you want to unpublish all service exposed by this Responder.
   * This method SHOULD be called before the node application exists, so any host on the
   * network is informed of the shutdown of this machine.
   * Calling the shutdown method is mandatory for a clean termination (sending goodbye packets).
   *
   * The shutdown method must only be called ONCE.
   *
   * @returns The Promise resolves once all goodbye packets were sent
   * (or immediately if any other users have a reference to this Responder instance).
   */
  public shutdown(): Promise<void> {
    this.refCount--; // we trust the user here, that the shutdown will not be executed twice or something :thinking:
    if (this.refCount > 0) {
      return Promise.resolve();
    }

    Responder.INSTANCES.delete(this.optionsString);

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
      .then(() => {
        this.announce(service).then(() => {
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
      }, reason => callback(reason));
  }

  private republishService(service: CiaoService, callback: PublishCallback): Promise<void> {
    // TODO handle PROBING, handle ANNOUNCING/PROBED
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Readvertising service...", service.getFQDN());

    // first of all remove it from our advertisedService Map and remove all of the maintained PTRs
    this.clearService(service);
    service.serviceState = ServiceState.UNANNOUNCED; // the service is now considered unannounced

    // and now we basically just announce the service by doing probing and the announce step
    return this.advertiseService(service, callback);
  }

  private unpublishService(service: CiaoService, callback?: UnpublishCallback): Promise<void> {
    if (service.serviceState === ServiceState.UNANNOUNCED) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    if (service.serviceState === ServiceState.ANNOUNCED) {
      debug("[%s] Removing service from the network", service.getFQDN());
      this.clearService(service);
      service.serviceState = ServiceState.UNANNOUNCED;

      let promise = this.goodbye(service);
      if (callback) {
        promise = promise.then(() => callback(), reason => callback(reason));
      }
      return promise;
    } else if (service.serviceState === ServiceState.ANNOUNCING) {
      // TODO cancel additional announcment steps
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

  private clearService(service: CiaoService): void {
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
        service.serviceState = ServiceState.PROBED;
      }, reason => {
        service.serviceState = ServiceState.UNANNOUNCED;
        this.currentProber = undefined;
        throw new Error("Failed probing for " + service.getFQDN() +": " + reason);
      });
  }

  private announce(service: CiaoService): Promise<void> {
    if (service.serviceState !== ServiceState.PROBED) {
      throw new Error("Cannot announce service which was not probed unique. Received " + service.serviceState + " for service " + service.getFQDN());
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
      service.serviceState = ServiceState.ANNOUNCING;

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
              service.serviceState = ServiceState.ANNOUNCED;
              resolve();
            }
          });
        }, 1000).unref();
      });
    });
  }

  private handleServiceRecordUpdate(service: CiaoService, records: ResourceRecord[], callback?: RecordsUpdateCallback): void {
    // when updating we just repeat the announce step
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    // TODO when in state ANNOUNCING, add to the queue

    debug("[%s] Updating %d record(s) for given service!", service.getFQDN(), records.length);

    this.server.sendResponseBroadcast( { answers: records }, callback);
  }

  private handleServiceRecordUpdateOnInterface(service: CiaoService, name: InterfaceName, records: ResourceRecord[], callback?: RecordsUpdateCallback): void {
    // when updating we just repeat the announce step
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    // TODO when in state ANNOUNCING, add to the queue

    debug("[%s] Updating %d record(s) for given service on interface %s!", service.getFQDN(), records.length, name);

    this.server.sendResponse({ answers: records }, name, callback);
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

  /**
   * @internal method called by the MDNSServer when an incoming query needs ot be handled
   */
  handleQuery(packet: DNSPacket, endpoint: EndpointInfo): void {
    const endpointId = endpoint.address + ":" + endpoint.port; // used to match truncated queries

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
    const knownAnswers = packet.answers;

    // define knownAnswers so the addAnswer/addAdditional method can check if records need to be added or not
    // known answer suppression according to RFC 6762 7.1.
    multicastResponse.defineKnownAnswers(knownAnswers);
    unicastResponse.defineKnownAnswers(knownAnswers);

    // gather answers for all the questions
    packet.questions.forEach(question => {
      this.answerQuestion(question, endpoint, question.unicastResponseFlag? unicastResponse: multicastResponse);
    });

    if (this.currentProber) {
      this.currentProber.handleQuery(packet);
    }

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
      debug("Sending response via unicast to " + JSON.stringify(endpoint) + " with "
        + unicastResponse.answers.map(answer => dnsTypeToString(answer.type)).join(";") + " answers and "
        + unicastResponse.additionals.map(answer => dnsTypeToString(answer.type)).join(";") + " additionals");
      this.server.sendResponse(unicastResponse, endpoint);
    }
    if (multicastResponse.hasAnswers()) {
      // TODO To protect the network against excessive packet flooding due to
      //    software bugs or malicious attack, a Multicast DNS responder MUST NOT
      //    (except in the one special case of answering probe queries) multicast
      //    a record on a given interface until at least one second has elapsed
      //    since the last time that record was multicast on that particular
      //    interface.

      debug("Sending response via multicast on network " + endpoint.interface + " with "
        + multicastResponse.answers.map(answer => dnsTypeToString(answer.type)).join(";") + " answers and "
        + multicastResponse.additionals.map(answer => dnsTypeToString(answer.type)).join(";") + " additionals");
      this.server.sendResponse(multicastResponse, endpoint.interface);
    }
  }

  /**
   * @internal method called by the MDNSServer when an incoming response needs ot be handled
   */
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

  private answerQuestion(question: Question, endpoint: EndpointInfo, response: QueryResponse): void {
    // RFC 6762 6: The determination of whether a given record answers a given question
    //    is made using the standard DNS rules: the record name must match the
    //    question name, the record rrtype must match the question qtype unless
    //    the qtype is "ANY" (255) or the rrtype is "CNAME" (5), and the record
    //    rrclass must match the question qclass unless the qclass is "ANY" (255).

    if (question.class !== QClass.IN && question.class !== QClass.ANY) {
      // We just publish answers with IN class. So only IN or ANY questions classes will match
      return;
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
              Responder.answerServiceQuestion(service, question, endpoint, response);
            } else {
              // it's probably question for PTR '_services._dns-sd._udp.local'
              // the PTR will just point to something like '_hap._tcp.local' thus no additional records need to be included
              response.addAnswer(new PTRRecord(question.name, data));
            }
          }
        } /* else if (loweredQuestionName.endsWith(".in-addr.arpa") || loweredQuestionName.endsWith(".ip6.arpa")) { // reverse address lookup
          const address = ipAddressFromReversAddressName(loweredQuestionName);

          for (const service of this.announcedServices.values()) {
            const record = service.reverseAddressMapping(address);
            if (record) {
              response.addAnswer(record);
            }
          }
        }
        We won't actually respond to reverse address queries.
        This typically confuses responders like avahi, which then over and over try to increment the hostname.
        */
        break;
      }
      default:
        for (const service of this.announcedServices.values()) {
          Responder.answerServiceQuestion(service, question, endpoint, response);
        }
        break;
    }
  }

  private static answerServiceQuestion(service: CiaoService, question: Question, endpoint: EndpointInfo, response: QueryResponse): void {
    // This assumes to be called from answerQuestion inside the Responder class and thus that certain
    // preconditions or special cases are already covered.
    // For one we assume classes are already matched.

    const questionName = dnsLowerCase(question.name);
    const askingAny = question.type === QType.ANY || question.type === QType.CNAME;

    const addAnswer = response.addAnswer.bind(response);
    const addAdditional = response.addAdditional.bind(response);

    // RFC 6762 6.2. In the event that a device has only IPv4 addresses but no IPv6
    //    addresses, or vice versa, then the appropriate NSEC record SHOULD be
    //    placed into the additional section, so that queriers can know with
    //    certainty that the device has no addresses of that kind.

    if (questionName === dnsLowerCase(service.getTypePTR())) {
      if (askingAny || question.type === QType.PTR) {
        const added = response.addAnswer(service.ptrRecord());

        if (added) {
          // only add additionals if answer is not supressed by the known answer section

          // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
          response.addAdditional(service.srvRecord(), service.txtRecord());
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
        }
      }
    } else if (questionName === dnsLowerCase(service.getFQDN())) {
      if (askingAny) {
        const added = response.addAnswer(service.srvRecord(), service.txtRecord());

        if (added) {
          // RFC 6763 12.2: include additionals: a, aaaa
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
        }
      } else if (question.type === QType.SRV) {
        const added = response.addAnswer(service.srvRecord());

        if (added) {
          // RFC 6763 12.2: include additionals: a, aaaa
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
        }
      } else if (question.type === QType.TXT) {
        response.addAnswer(service.txtRecord());

        // RFC 6763 12.3: no not any other additionals
      }
    } else if (questionName === dnsLowerCase(service.getHostname())) {
      if (askingAny) {
        this.addAddressRecords(service, endpoint, RType.A, addAnswer);
        this.addAddressRecords(service, endpoint, RType.AAAA, addAnswer);
        response.addAnswer(service.nsecRecord());
      } else if (question.type === QType.A) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        const added = this.addAddressRecords(service, endpoint, RType.A, addAnswer);
        if (added) {
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
        }

        response.addAnswer(service.nsecRecord()); // always add the negative response, always assert dominance
      } else if (question.type === QType.AAAA) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        const added = this.addAddressRecords(service, endpoint, RType.AAAA, addAnswer);
        if (added) {
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
        }

        response.addAnswer(service.nsecRecord()); // always add the negative response, always assert dominance
      }
    } else if (service.getSubtypePTRs()) {
      if (askingAny || question.type === QType.PTR) {
        const dnsLowerSubTypes = service.getSubtypePTRs()!.map(dnsLowerCase);
        const index = dnsLowerSubTypes.indexOf(questionName);

        if (index !== -1) { // we have a sub type for the question
          const records = service.subtypePtrRecords();
          const record = records![index];
          assert(questionName === dnsLowerCase(record.name), "Question Name didn't match selected sub type ptr record!");

          const added = response.addAnswer(record);
          if (added) {
            // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
            response.addAdditional(service.srvRecord(), service.txtRecord());
            this.addAddressRecords(service, endpoint, RType.A, addAdditional);
            this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
          }
        }
      }
    }
  }

  /**
   * This method is a helper method to reduce the complexity inside {@link answerServiceQuestion}.
   * The method calculates which A and AAAA records to be added for a given {@code endpoint} using
   * the records from the provided {@code service}.
   * It will add the records by calling the provided {@code dest} method.
   *
   * @param {CiaoService} service - service which records to be use
   * @param {EndpointInfo} endpoint - endpoint information providing the interface
   * @param {RType.A | RType.AAAA} type - defines the type of records to be added
   * @param {RecordAddMethod} dest - defines the destination which the records should be added
   * @returns true if any records got added
   */
  private static addAddressRecords(service: CiaoService, endpoint: EndpointInfo, type: RType.A | RType.AAAA, dest: RecordAddMethod): boolean {
    if (type === RType.A) {
      const record = service.aRecord(endpoint.interface);
      return record? dest(record): false;
    } else if (type === RType.AAAA) {
      const record = service.aaaaRecord(endpoint.interface);
      const routableRecord = service.aaaaRoutableRecord(endpoint.interface);

      let addedAny = false;
      if (record) {
        addedAny = dest(record);
      }
      if (routableRecord) {
        const added = dest(routableRecord);
        addedAny = addedAny || added;
      }

      return addedAny;
    } else {
      assert.fail("Illegal argument!");
    }
  }

  private sendResponseAddingAddressRecords(service: CiaoService, records: ResourceRecord[], goodbye: boolean, callback?: SendCallback): void {
    let iterations = this.server.getNetworkCount();
    const encounteredErrors: Error[] = [];

    for (const name of this.server.getInterfaceNames()) {
      const answer: ResourceRecord[] = records.concat([]);

      const aRecord = service.aRecord(name);
      const aaaaRecord = service.aaaaRecord(name);
      const aaaaRoutableRecord = service.aaaaRoutableRecord(name);
      //const reversMappings: PTRRecord[] = service.reverseAddressMappings(networkInterface);
      const nsecRecord = service.nsecRecord();

      if (aRecord) {
        if (goodbye) {
          aRecord.ttl = 0;
        }
        answer.push(aRecord);
      }

      if (aaaaRecord) {
        if (goodbye) {
          aaaaRecord.ttl = 0;
        }
        answer.push(aaaaRecord);
      }
      if (aaaaRoutableRecord) {
        if (goodbye) {
          aaaaRoutableRecord.ttl = 0;
        }
        answer.push(aaaaRoutableRecord);
      }

      /*
      for (const reversMapping of reversMappings) {
        if (goodbye) {
          reversMapping.ttl = 0;
        }
        answer.push(reversMapping);
      }
      */

      if (goodbye) {
        nsecRecord.ttl = 0;
      }
      answer.push(nsecRecord);

      if (!callback) {
        this.server.sendResponse({ answers: answer }, name);
      } else {
        this.server.sendResponse({ answers: answer }, name, error => {
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
