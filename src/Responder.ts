import assert from "assert";
import createDebug from "debug";
import {
  CiaoService,
  InternalServiceEvent,
  PublishCallback,
  RecordsUpdateCallback,
  ServiceOptions,
  ServiceState,
  UnpublishCallback,
} from "./CiaoService";
import { DNSPacket, DNSResponseDefinition, QClass, QType, RType } from "./coder/DNSPacket";
import { Question } from "./coder/Question";
import { AAAARecord } from "./coder/records/AAAARecord";
import { ARecord } from "./coder/records/ARecord";
import { OPTRecord } from "./coder/records/OPTRecord";
import { PTRRecord } from "./coder/records/PTRRecord";
import { SRVRecord } from "./coder/records/SRVRecord";
import { TXTRecord } from "./coder/records/TXTRecord";
import { ResourceRecord } from "./coder/ResourceRecord";
import {
  EndpointInfo,
  MDNSServer,
  MDNSServerOptions,
  PacketHandler,
  SendResultFailedRatio,
  SendResultFormatError,
} from "./MDNSServer";
import { InterfaceName, NetworkManagerEvent, NetworkUpdate } from "./NetworkManager";
import { Announcer } from "./responder/Announcer";
import { Prober } from "./responder/Prober";
import { QueryResponse, RecordAddMethod } from "./responder/QueryResponse";
import { QueuedResponse } from "./responder/QueuedResponse";
import { TruncatedQuery, TruncatedQueryEvent, TruncatedQueryResult } from "./responder/TruncatedQuery";
import { ERR_INTERFACE_NOT_FOUND, ERR_SERVER_CLOSED } from "./util/errors";
import { PromiseTimeout } from "./util/promise-utils";
import { sortedInsert } from "./util/sorted-array";

const debug = createDebug("ciao:Responder");

const queuedResponseComparator = (a: QueuedResponse, b: QueuedResponse) => {
  return a.estimatedTimeToBeSent - b.estimatedTimeToBeSent;
};

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
  /**
   * map representing all our shared PTR records.
   * Typically we hold stuff like '_services._dns-sd._udp.local' (RFC 6763 9.), '_hap._tcp.local'.
   * Also pointers for every subtype like '_printer._sub._http._tcp.local' are inserted here.
   *
   * For every pointer we may hold multiple entries (like multiple services can advertise on _hap._tcp.local).
   * The key as well as all values are {@link dnsLowerCase}
   */
  private readonly servicePointer: Map<string, string[]> = new Map();

  private readonly truncatedQueries: Record<string, TruncatedQuery> = {}; // indexed by <ip>:<port>
  private readonly delayedMulticastResponses: QueuedResponse[] = [];

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

    this.server.getNetworkManager().on(NetworkManagerEvent.NETWORK_UPDATE, this.handleNetworkUpdate.bind(this));
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
      promises.push(this.unpublishService(service));
    }

    // eslint-disable-next-line
    return Promise.all(promises).then(() => {
      this.server.shutdown();
      this.bound = false;
    });
  }

  public getAnnouncedServices(): IterableIterator<CiaoService> {
    return this.announcedServices.values();
  }

  private start(): Promise<void> {
    if (this.bound) {
      throw new Error("Server is already bound!");
    }

    this.bound = true;
    return this.server.bind();
  }

  private advertiseService(service: CiaoService, callback: PublishCallback): Promise<void> {
    if (service.serviceState === ServiceState.ANNOUNCED) {
      throw new Error("Can't publish a service that is already announced. Received " + service.serviceState + " for service " + service.getFQDN());
    } else if (service.serviceState === ServiceState.PROBING) {
      return this.promiseChain.then(() => {
        if (service.currentAnnouncer) {
          return service.currentAnnouncer.awaitAnnouncement();
        }
      });
    } else if (service.serviceState === ServiceState.ANNOUNCING) {
      assert(service.currentAnnouncer, "Service is in state ANNOUNCING though has no linked announcer!");
      if (service.currentAnnouncer!.isSendingGoodbye()) {
        return service.currentAnnouncer!.awaitAnnouncement().then(() => this.advertiseService(service, callback));
      } else {
        return service.currentAnnouncer!.cancel().then(() => this.advertiseService(service, callback));
      }
    }

    debug("[%s] Going to advertise service...", service.getFQDN()); // TODO include restricted addresses and stuff

    // multicast loopback is not enabled for our sockets, though we do some stuff, so Prober will handle potential
    // name conflicts with our own services:
    //  - One Responder will always run ONE prober: no need to handle simultaneous probe tiebreaking
    //  - Prober will call the Responder to generate responses to its queries to
    //      resolve name conflicts the same way as with other services on the network

    this.promiseChain = this.promiseChain // we synchronize all ongoing probes here
      .then(() => service.rebuildServiceRecords()) // build the records the first time for the prober
      .then(() => this.probe(service)); // probe errors are catch below

    return this.promiseChain.then(() => {
      // we are not returning the promise returned by announced here, only PROBING is synchronized
      this.announce(service).catch(reason => {
        // handle announce errors
        console.log(`[${service.getFQDN()}] failed announcing with reason: ${reason}. Trying again in 2 seconds!`);
        return PromiseTimeout(2000).then(() => this.advertiseService(service, () => {
          // empty
        }));
      });

      callback(); // service is considered announced. After the call to the announce() method the service state is set to ANNOUNCING
    }, reason => {
      /*
       * I know seems unintuitive to place the probe error handling below here, miles away from the probe method call.
       * Trust me it makes sense (encountered regression now two times in a row).
       * 1. We can't put it in the THEN call above, since then errors simply won't be handled from the probe method call.
       *  (CANCEL error would be passed through and would result in some unwanted stack trace)
       * 2. We can't add a catch call above, since otherwise we would silence the CANCEL would be silenced and announce
       *  would be called anyways.
       */

      // handle probe error
      if (reason === Prober.CANCEL_REASON) {
        callback();
      } else { // other errors are only thrown when sockets error occur
        console.log(`[${service.getFQDN()}] failed probing with reason: ${reason}. Trying again in 2 seconds!`);
        return PromiseTimeout(2000).then(() => this.advertiseService(service, callback));
      }
    });
  }

  private republishService(service: CiaoService, callback: PublishCallback, delayAnnounce = false): Promise<void> {
    if (service.serviceState !== ServiceState.ANNOUNCED && service.serviceState !== ServiceState.ANNOUNCING) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Readvertising service...", service.getFQDN());

    if (service.serviceState === ServiceState.ANNOUNCING) {
      assert(service.currentAnnouncer, "Service is in state ANNOUNCING though has no linked announcer!");

      const promise = service.currentAnnouncer!.isSendingGoodbye()
        ? service.currentAnnouncer!.awaitAnnouncement()
        : service.currentAnnouncer!.cancel();

      return promise.then(() => this.advertiseService(service, callback));
    }

    // first of all remove it from our advertisedService Map and remove all of the maintained PTRs
    this.clearService(service);
    service.serviceState = ServiceState.UNANNOUNCED; // the service is now considered unannounced

    // and now we basically just announce the service by doing probing and the announce step
    if (delayAnnounce) {
      return PromiseTimeout(1000)
        .then(() => this.advertiseService(service, callback));
    } else {
      return this.advertiseService(service, callback);
    }
  }

  private unpublishService(service: CiaoService, callback?: UnpublishCallback): Promise<void> {
    if (service.serviceState === ServiceState.UNANNOUNCED) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    if (service.serviceState === ServiceState.ANNOUNCED || service.serviceState === ServiceState.ANNOUNCING) {
      if (service.serviceState === ServiceState.ANNOUNCING) {
        assert(service.currentAnnouncer, "Service is in state ANNOUNCING though has no linked announcer!");
        if (service.currentAnnouncer!.isSendingGoodbye()) {
          return service.currentAnnouncer!.awaitAnnouncement(); // we are already sending a goodbye
        }

        return service.currentAnnouncer!.cancel().then(() => {
          service.serviceState = ServiceState.ANNOUNCED; // unpublishService requires announced state
          return this.unpublishService(service, callback);
        });
      }

      debug("[%s] Removing service from the network", service.getFQDN());
      this.clearService(service);
      service.serviceState = ServiceState.UNANNOUNCED;

      let promise = this.goodbye(service);
      if (callback) {
        promise = promise.then(() => callback(), reason => {
          console.log(`[${service.getFQDN()}] failed goodbye with reason: ${reason}.`);
          callback();
        });
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

    callback && callback();
    return Promise.resolve();
  }

  private clearService(service: CiaoService): void {
    const serviceFQDN = service.getLowerCasedFQDN();
    const typePTR = service.getLowerCasedTypePTR();
    const subtypePTRs = service.getLowerCasedSubtypePTRs(); // possibly undefined

    this.removePTR(Responder.SERVICE_TYPE_ENUMERATION_NAME, typePTR);
    this.removePTR(typePTR, serviceFQDN);
    if (subtypePTRs) {
      for (const ptr of subtypePTRs) {
        this.removePTR(ptr, serviceFQDN);
      }
    }

    this.announcedServices.delete(service.getLowerCasedFQDN());
  }

  private addPTR(ptr: string, name: string): void {
    // we don't call lower case here, as we expect the caller to have done that already
    // name = dnsLowerCase(name); // worst case is that the meta query ptr record contains lower cased destination

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
    this.currentProber = new Prober(this, this.server, service);
    return this.currentProber.probe()
      .then(() => {
        this.currentProber = undefined;
        service.serviceState = ServiceState.PROBED;
      }, reason => {
        service.serviceState = ServiceState.UNANNOUNCED;
        this.currentProber = undefined;
        return Promise.reject(reason); // forward reason
      });
  }

  private announce(service: CiaoService): Promise<void> {
    if (service.serviceState !== ServiceState.PROBED) {
      throw new Error("Cannot announce service which was not probed unique. Received " + service.serviceState + " for service " + service.getFQDN());
    }
    assert(service.currentAnnouncer === undefined, "Service " + service.getFQDN() + " is already announcing!");

    service.serviceState = ServiceState.ANNOUNCING;

    const announcer = new Announcer(this.server, service, {
      repetitions: 3,
    });
    service.currentAnnouncer = announcer;

    const serviceFQDN = service.getLowerCasedFQDN();
    const typePTR = service.getLowerCasedTypePTR();
    const subtypePTRs = service.getLowerCasedSubtypePTRs(); // possibly undefined

    this.addPTR(Responder.SERVICE_TYPE_ENUMERATION_NAME, typePTR);
    this.addPTR(typePTR, serviceFQDN);
    if (subtypePTRs) {
      for (const ptr of subtypePTRs) {
        this.addPTR(ptr, serviceFQDN);
      }
    }

    this.announcedServices.set(serviceFQDN, service);

    return announcer.announce().then(() => {
      service.serviceState = ServiceState.ANNOUNCED;
      service.currentAnnouncer = undefined;
    }, reason => {
      service.serviceState = ServiceState.UNANNOUNCED;
      service.currentAnnouncer = undefined;

      this.clearService(service); // also removes entry from announcedServices

      if (reason !== Announcer.CANCEL_REASON) {
        // forward reason if it is not a cancellation.
        // We do not forward cancel reason. Announcements only get cancelled if we have something "better" to do.
        // So the race is already handled by us.
        return Promise.reject(reason);
      }
    });
  }

  private handleServiceRecordUpdate(service: CiaoService, response: DNSResponseDefinition, callback?: RecordsUpdateCallback): void {
    // when updating we just repeat the announce step
    if (service.serviceState !== ServiceState.ANNOUNCED) { // different states are already handled in CiaoService where this event handler is fired
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Updating %d record(s) for given service!", service.getFQDN(), response.answers.length + (response.additionals?.length || 0));

    // TODO we should do a announcement at this point "in theory"
    this.server.sendResponseBroadcast(response, service).then(results => {
      const failRatio = SendResultFailedRatio(results);
      if (failRatio === 1) {
        console.log(SendResultFormatError(results, `Failed to send records update for '${service.getFQDN()}'`), true);
        if (callback) {
          callback(new Error("Updating records failed as of socket errors!"));
        }
        return; // all failed => updating failed
      }

      if (failRatio > 0) {
        // some queries on some interfaces failed, but not all. We log that but consider that to be a success
        // at this point we are not responsible for removing stale network interfaces or something
        debug(SendResultFormatError(results, `Some of the record updates for '${service.getFQDN()}' failed`));
        // SEE no return here
      }

      if (callback) {
        callback();
      }
    });
  }

  private handleServiceRecordUpdateOnInterface(service: CiaoService, name: InterfaceName, records: ResourceRecord[], callback?: RecordsUpdateCallback): void {
    // when updating we just repeat the announce step
    if (service.serviceState !== ServiceState.ANNOUNCED) { // different states are already handled in CiaoService where this event handler is fired
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Updating %d record(s) for given service on interface %s!", service.getFQDN(), records.length, name);

    const packet = DNSPacket.createDNSResponsePacketsFromRRSet({ answers: records });
    this.server.sendResponse(packet, name, callback);
  }

  private goodbye(service: CiaoService): Promise<void> {
    assert(service.currentAnnouncer === undefined, "Service " + service.getFQDN() + " is already announcing!");

    service.serviceState = ServiceState.ANNOUNCING;

    const announcer = new Announcer(this.server, service, {
      repetitions: 1,
      goodbye: true,
    });
    service.currentAnnouncer = announcer;

    return announcer.announce().then(() => {
      service.serviceState = ServiceState.UNANNOUNCED;
      service.currentAnnouncer = undefined;
    }, reason => {
      // just assume unannounced. we won't be answering anymore, so the record will be flushed from cache sometime.
      service.serviceState = ServiceState.UNANNOUNCED;
      service.currentAnnouncer = undefined;
      return Promise.reject(reason);
    });
  }

  private handleNetworkUpdate(change: NetworkUpdate): void {
    for (const service of this.announcedServices.values()) {
      service.handleNetworkInterfaceUpdate(change);
    }
  }

  /**
   * @internal method called by the MDNSServer when an incoming query needs ot be handled
   */
  handleQuery(packet: DNSPacket, endpoint: EndpointInfo): void {
    const start = new Date().getTime();

    const endpointId = endpoint.address + ":" + endpoint.port + ":" + endpoint.interface; // used to match truncated queries

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
      debug("Received truncated query from " + JSON.stringify(endpoint) + " waiting for more to come!");

      const truncatedQuery = new TruncatedQuery(packet);
      this.truncatedQueries[endpointId] = truncatedQuery;
      truncatedQuery.on(TruncatedQueryEvent.TIMEOUT, () => {
        // called when more than 400-500ms pass until the next packet arrives
        debug("[%s] Timeout passed since the last truncated query was received. Discarding %d packets received in %d ms.",
          endpointId, truncatedQuery.getArrivedPacketCount(), truncatedQuery.getTotalWaitTime());
        delete this.truncatedQueries[endpointId];
      });

      return; // wait for the next query
    }

    const isUnicastQuerier = endpoint.port !== MDNSServer.MDNS_PORT; // explained below
    const isProbeQuery = packet.authorities.size > 0;

    let udpPayloadSize: number | undefined = undefined; // payload size supported by the querier
    for (const record of packet.additionals.values()) {
      if (record.type === RType.OPT) {
        udpPayloadSize = (record as OPTRecord).udpPayloadSize;
        break;
      }
    }

    // responses must not include questions RFC 6762 6.
    // known answer suppression according to RFC 6762 7.1.
    const multicastResponses: QueryResponse[] = [ new QueryResponse(packet.answers) ];
    const unicastResponses: QueryResponse[] = [ new QueryResponse(packet.answers) ];

    // gather answers for all the questions
    packet.questions.forEach(question => {
      const responses = (question.unicastResponseFlag || isUnicastQuerier)? unicastResponses: multicastResponses;
      responses.push(...this.answerQuestion(question, endpoint, responses[0]));
    });

    if (this.currentProber) {
      this.currentProber.handleQuery(packet, endpoint);
    }

    if (isUnicastQuerier) {
      // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
      //  * MUSTS: response via unicast, repeat query ID, repeat questions, clear cache flush bit
      //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism

      for (let i = 0; i < unicastResponses.length; i++) {
        const response = unicastResponses[i];
        // only add questions to the first packet (will be combined anyways) and we must ensure
        // each packet stays unique in it's records
        response.markLegacyUnicastResponse(packet.id, i === 0? Array.from(packet.questions.values()): undefined);
      }
    }

    // RFC 6762 6.4. Response aggregation:
    //    When possible, a responder SHOULD, for the sake of network
    //    efficiency, aggregate as many responses as possible into a single
    //    Multicast DNS response message.  For example, when a responder has
    //    several responses it plans to send, each delayed by a different
    //    interval, then earlier responses SHOULD be delayed by up to an
    //    additional 500 ms if that will permit them to be aggregated with
    //    other responses scheduled to go out a little later.
    QueryResponse.combineResponses(multicastResponses, udpPayloadSize);
    QueryResponse.combineResponses(unicastResponses, udpPayloadSize);

    if (isUnicastQuerier && unicastResponses.length > 1) {
      // RFC 6762 18.5. In legacy unicast response messages, the TC bit has the same meaning
      //    as in conventional Unicast DNS: it means that the response was too
      //    large to fit in a single packet, so the querier SHOULD reissue its
      //    query using TCP in order to receive the larger response.

      unicastResponses.splice(1, unicastResponses.length - 1); // discard all other
      unicastResponses[0].markTruncated();
    }

    for (const unicastResponse of unicastResponses) {
      if (!unicastResponse.hasAnswers()) {
        continue;
      }

      this.server.sendResponse(unicastResponse.asPacket(), endpoint);
      const time = new Date().getTime() - start;
      debug("Sending response via unicast to %s (took %d ms): %s", JSON.stringify(endpoint), time, unicastResponse.asString(udpPayloadSize));
    }

    for (const multicastResponse of multicastResponses) {
      if (!multicastResponse.hasAnswers()) {
        continue;
      }

      if ((multicastResponse.containsSharedAnswer() || packet.questions.size > 1) && !isProbeQuery) {
        // We must delay the response on a interval of 20-120ms if we can't assure that we are the only one responding (shared records).
        // This is also the case if there are multiple questions. If multiple questions are asked
        // we probably could not answer them all (because not all of them were directed to us).
        // All those conditions are overridden if this is a probe query. To those queries we must respond instantly!

        const time = new Date().getTime() - start;
        this.enqueueDelayedMulticastResponse(multicastResponse.asPacket(), endpoint.interface, time);
      } else {
        // otherwise the response is sent immediately, if there isn't any packet in the queue

        // so first step is, check if there is a packet in the queue we are about to send out
        // which can be combined with our current packet without adding a delay > 500ms
        let sentWithLaterPacket = false;

        for (let i = 0; i < this.delayedMulticastResponses.length; i++) {
          const delayedResponse = this.delayedMulticastResponses[i];

          if (delayedResponse.getTimeTillSent() > QueuedResponse.MAX_DELAY) {
            // all packets following won't be compatible either
            break;
          }

          if (delayedResponse.combineWithUniqueResponseIfPossible(multicastResponse, endpoint.interface)) {
            const time = new Date().getTime() - start;
            sentWithLaterPacket = true;
            debug("Multicast response on interface %s containing unique records (took %d ms) was combined with response which is sent out later", endpoint.interface, time);
            break;
          }
        }

        if (!sentWithLaterPacket) {
          this.server.sendResponse(multicastResponse.asPacket(), endpoint.interface);
          const time = new Date().getTime() - start;
          debug("Sending response via multicast on network %s (took %d ms): %s", endpoint.interface, time, multicastResponse.asString(udpPayloadSize));
        }
      }
    }
  }

  /**
   * @internal method called by the MDNSServer when an incoming response needs to be handled
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleResponse(packet: DNSPacket, endpoint: EndpointInfo): void {
    // any questions in a response must be ignored RFC 6762 6.

    if (this.currentProber) { // if there is a probing process running currently, just forward all messages to it
      this.currentProber.handleResponse(packet, endpoint);
    }

    for (const service of this.announcedServices.values()) {
      let conflictingRecord: ResourceRecord | undefined = undefined;

      for (const record of packet.answers.values()) {
        if (Responder.hasConflict(service, record, endpoint)) {
          conflictingRecord = record;
          break;
        }
      }

      if (!conflictingRecord) {
        for (const record of packet.additionals.values()) {
          if (Responder.hasConflict(service, record, endpoint)) {
            conflictingRecord = record;
            break;
          }
        }
      }

      if (conflictingRecord) {
        // noinspection JSIgnoredPromiseFromCall
        this.republishService(service, error => {
          if (error) {
            console.log("FATAL Error occurred trying to resolve conflict for service " + service.getFQDN() + "! We can't recover from this!");
            console.log(error.stack);
            process.exit(1); // we have a service which should be announced, though we failed to reannounce.
            // if this should ever happen in reality, whe might want to introduce a more sophisticated recovery
            // for situations where it makes sense
          }
        }, true);
      }
    }
  }

  private static hasConflict(service: CiaoService, record: ResourceRecord, endpoint: EndpointInfo): boolean {
    // RFC 6762 9. Conflict Resolution:
    //    A conflict occurs when a Multicast DNS responder has a unique record
    //    for which it is currently authoritative, and it receives a Multicast
    //    DNS response message containing a record with the same name, rrtype
    //    and rrclass, but inconsistent rdata.  What may be considered
    //    inconsistent is context sensitive, except that resource records with
    //    identical rdata are never considered inconsistent, even if they
    //    originate from different hosts.  This is to permit use of proxies and
    //    other fault-tolerance mechanisms that may cause more than one
    //    responder to be capable of issuing identical answers on the network.
    //
    //    A common example of a resource record type that is intended to be
    //    unique, not shared between hosts, is the address record that maps a
    //    host's name to its IP address.  Should a host witness another host
    //    announce an address record with the same name but a different IP
    //    address, then that is considered inconsistent, and that address
    //    record is considered to be in conflict.
    //
    //    Whenever a Multicast DNS responder receives any Multicast DNS
    //    response (solicited or otherwise) containing a conflicting resource
    //    record in any of the Resource Record Sections, the Multicast DNS
    //    responder MUST immediately reset its conflicted unique record to
    //    probing state, and go through the startup steps described above in
    //    Section 8, "Probing and Announcing on Startup".  The protocol used in
    //    the Probing phase will determine a winner and a loser, and the loser
    //    MUST cease using the name, and reconfigure.
    if (!service.advertisesOnInterface(endpoint.interface)) {
      return false;
    }

    if (record.ttl === 0) {
      // we currently don't care about goodbye packets.
      // we could someday add a logic, to handle the case, where a goodbye packet was incorrectly send
      // and we need to immediately correct that by sending out our records
      return false;
    }

    const recordName = record.getLowerCasedName();

    if (recordName === service.getLowerCasedFQDN()) {
      if (record.type === RType.SRV) {
        const srvRecord = record as SRVRecord;
        if (srvRecord.getLowerCasedHostname() !== service.getLowerCasedHostname()) {
          debug("[%s] Noticed conflicting record on the network. SRV with hostname: %s", service.getFQDN(), srvRecord.hostname);
          return true;
        } else if (srvRecord.port !== service.getPort()) {
          debug("[%s] Noticed conflicting record on the network. SRV with port: %s", service.getFQDN(), srvRecord.port);
          return true;
        }
      } else if (record.type === RType.TXT) {
        const txtRecord = record as TXTRecord;
        const txt = service.getTXT();

        if (txt.length !== txtRecord.txt.length) { // length differs, can't be the same data
          debug("[%s] Noticed conflicting record on the network. TXT with differing data length", service.getFQDN());
          return true;
        }

        for (let i = 0; i < txt.length; i++) {
          const buffer0 = txt[i];
          const buffer1 = txtRecord.txt[i];

          if (buffer0.length !== buffer1.length || buffer0.toString("hex") !== buffer1.toString("hex")) {
            debug("[%s] Noticed conflicting record on the network. TXT with differing data.", service.getFQDN());
            return true;
          }
        }
      }
    } else if (recordName === service.getLowerCasedHostname()) {
      if (record.type === RType.A) {
        const aRecord = record as ARecord;

        if (!service.hasAddress(aRecord.ipAddress)) {
          // if the service doesn't expose the listed address we have a conflict
          debug("[%s] Noticed conflicting record on the network. A with ip address: %s", service.getFQDN(), aRecord.ipAddress);
          return true;
        }
      } else if (record.type === RType.AAAA) {
        const aaaaRecord = record as AAAARecord;

        if (!service.hasAddress(aaaaRecord.ipAddress)) {
          // if the service doesn't expose the listed address we have a conflict
          debug("[%s] Noticed conflicting record on the network. AAAA with ip address: %s", service.getFQDN(), aaaaRecord.ipAddress);
          return true;
        }
      }
    }

    return false;
  }

  private enqueueDelayedMulticastResponse(packet: DNSPacket, interfaceName: InterfaceName, time: number): void {
    const response = new QueuedResponse(packet, interfaceName);
    response.calculateRandomDelay();

    sortedInsert(this.delayedMulticastResponses, response, queuedResponseComparator);

    // run combine/delay checks
    for (let i = 0; i < this.delayedMulticastResponses.length; i++) {
      const response0 = this.delayedMulticastResponses[i];

      // search for any packets sent out after this packet
      for (let j = i + 1; j < this.delayedMulticastResponses.length; j++) {
        const response1 = this.delayedMulticastResponses[j];

        if (!response0.delayWouldBeInTimelyManner(response1)) {
          // all packets following won't be compatible either
          break;
        }

        if (response0.combineWithNextPacketIfPossible(response1)) {
          // combine was a success and the packet got delay

          // remove the packet from the queue
          const index = this.delayedMulticastResponses.indexOf(response0);
          if (index !== -1) {
            this.delayedMulticastResponses.splice(index, 1);
          }
          i--; // reduce i, as one element got removed from the queue

          break;
        }

        // otherwise we continue with maybe some packets further ahead
      }
    }

    if (!response.delayed) {
      // only set timer if packet got not delayed

      response.scheduleResponse(() => {
        const index = this.delayedMulticastResponses.indexOf(response);
        if (index !== -1) {
          this.delayedMulticastResponses.splice(index, 1);
        }

        try {
          this.server.sendResponse(response.getPacket(), interfaceName);
          debug("Sending (delayed %dms) response via multicast on network interface %s (took %d ms): %s",
            Math.round(response.getTimeSinceCreation()), interfaceName, time, response.getPacket().asLoggingString());
        } catch (error) {
          if (error.name === ERR_INTERFACE_NOT_FOUND) {
            debug("Multicast response (delayed %dms) was cancelled as the network interface %s is no longer available!",
              Math.round(response.getTimeSinceCreation()), interfaceName);
          } else if (error.name === ERR_SERVER_CLOSED) {
            debug("Multicast response (delayed %dms) was cancelled as the server is about to be shutdown!",
              Math.round(response.getTimeSinceCreation()));
          } else {
            throw error;
          }
        }
      });
    }
  }

  private answerQuestion(question: Question, endpoint: EndpointInfo, mainResponse: QueryResponse): QueryResponse[] {
    // RFC 6762 6: The determination of whether a given record answers a given question
    //    is made using the standard DNS rules: the record name must match the
    //    question name, the record rrtype must match the question qtype unless
    //    the qtype is "ANY" (255) or the rrtype is "CNAME" (5), and the record
    //    rrclass must match the question qclass unless the qclass is "ANY" (255).

    if (question.class !== QClass.IN && question.class !== QClass.ANY) {
      // We just publish answers with IN class. So only IN or ANY questions classes will match
      return [];
    }

    const serviceResponses: QueryResponse[] = [];

    if (question.type === QType.PTR || question.type === QType.ANY || question.type === QType.CNAME) {
      const destinations = this.servicePointer.get(question.getLowerCasedName()); // look up the pointer, all entries are dnsLowerCased

      if (destinations) {
        // if it's a pointer name, we handle it here
        for (const data of destinations) {
          // check if the PTR is pointing towards a service, like in questions for PTR '_hap._tcp.local'
          // if that's the case, let the question be answered by the service itself
          const service = this.announcedServices.get(data);

          if (service) {
            if (service.advertisesOnInterface(endpoint.interface)) {
              // call the method for original question, so additionals get added properly
              const response = Responder.answerServiceQuestion(service, question, endpoint, mainResponse);
              if (response.hasAnswers()) {
                serviceResponses.push(response);
              }
            }
          } else {
            // it's probably question for PTR '_services._dns-sd._udp.local'
            // the PTR will just point to something like '_hap._tcp.local' thus no additional records need to be included
            mainResponse.addAnswer(new PTRRecord(question.name, data));
            // we may send out meta queries on interfaces where there aren't any services, because they are
            //  restricted to other interfaces.
          }
        }

        return serviceResponses; // if we got in this if-body, it was a pointer name and we handled it correctly
      } /* else if (loweredQuestionName.endsWith(".in-addr.arpa") || loweredQuestionName.endsWith(".ip6.arpa")) { // reverse address lookup
          const address = ipAddressFromReversAddressName(loweredQuestionName);

          for (const service of this.announcedServices.values()) {
            const record = service.reverseAddressMapping(address);
            if (record) {
              mainResponse.addAnswer(record);
            }
          }
        }
        We won't actually respond to reverse address queries.
        This typically confuses responders like avahi, which then over and over try to increment the hostname.
        */
    }

    for (const service of this.announcedServices.values()) {
      if (!service.advertisesOnInterface(endpoint.interface)) {
        continue;
      }

      const response = Responder.answerServiceQuestion(service, question, endpoint, mainResponse);
      if (response.hasAnswers()) {
        serviceResponses.push(response);
      }
    }

    return serviceResponses;
  }

  private static answerServiceQuestion(service: CiaoService, question: Question, endpoint: EndpointInfo, mainResponse: QueryResponse): QueryResponse {
    // This assumes to be called from answerQuestion inside the Responder class and thus that certain
    // preconditions or special cases are already covered.
    // For one we assume classes are already matched.

    const response = new QueryResponse(mainResponse.knownAnswers);

    const loweredQuestionName = question.getLowerCasedName();
    const askingAny = question.type === QType.ANY || question.type === QType.CNAME;

    const addAnswer = response.addAnswer.bind(response);
    const addAdditional = response.addAdditional.bind(response);

    // RFC 6762 6.2. In the event that a device has only IPv4 addresses but no IPv6
    //    addresses, or vice versa, then the appropriate NSEC record SHOULD be
    //    placed into the additional section, so that queriers can know with
    //    certainty that the device has no addresses of that kind.

    if (loweredQuestionName === service.getLowerCasedTypePTR()) {
      if (askingAny || question.type === QType.PTR) {
        const added = response.addAnswer(service.ptrRecord());

        if (added) {
          // only add additionals if answer is not suppressed by the known answer section

          // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
          response.addAdditional(service.txtRecord(), service.srvRecord());
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
          response.addAdditional(service.serviceNSECRecord(), service.addressNSECRecord());
        }
      }
    } else if (loweredQuestionName === service.getLowerCasedFQDN()) {
      if (askingAny) {
        response.addAnswer(service.txtRecord());
        const addedSrv = response.addAnswer(service.srvRecord());

        if (addedSrv) {
          // RFC 6763 12.2: include additionals: a, aaaa
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
          response.addAdditional(service.serviceNSECRecord(), service.addressNSECRecord());
        }
      } else if (question.type === QType.SRV) {
        const added = response.addAnswer(service.srvRecord());

        if (added) {
          // RFC 6763 12.2: include additionals: a, aaaa
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
          response.addAdditional(service.serviceNSECRecord(true), service.addressNSECRecord());
        }
      } else if (question.type === QType.TXT) {
        response.addAnswer(service.txtRecord());

        // RFC 6763 12.3: no not any other additionals
      }
    } else if (loweredQuestionName === service.getLowerCasedHostname() || loweredQuestionName + "local." === service.getLowerCasedHostname()) {
      if (askingAny) {
        this.addAddressRecords(service, endpoint, RType.A, addAnswer);
        this.addAddressRecords(service, endpoint, RType.AAAA, addAnswer);
        response.addAdditional(service.addressNSECRecord());
      } else if (question.type === QType.A) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        const added = this.addAddressRecords(service, endpoint, RType.A, addAnswer);
        if (added) {
          this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
        }

        response.addAdditional(service.addressNSECRecord()); // always add the negative response, always assert dominance
      } else if (question.type === QType.AAAA) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        const added = this.addAddressRecords(service, endpoint, RType.AAAA, addAnswer);
        if (added) {
          this.addAddressRecords(service, endpoint, RType.A, addAdditional);
        }

        response.addAdditional(service.addressNSECRecord()); // always add the negative response, always assert dominance
      }
    } else if (service.getLowerCasedSubtypePTRs()) {
      if (askingAny || question.type === QType.PTR) {
        const dnsLowerSubTypes = service.getLowerCasedSubtypePTRs()!;
        const index = dnsLowerSubTypes.indexOf(loweredQuestionName);

        if (index !== -1) { // we have a sub type for the question
          const records = service.subtypePtrRecords();
          const record = records![index];
          assert(loweredQuestionName === record.name, "Question Name didn't match selected sub type ptr record!");

          const added = response.addAnswer(record);
          if (added) {
            // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
            response.addAdditional(service.txtRecord(), service.srvRecord());
            this.addAddressRecords(service, endpoint, RType.A, addAdditional);
            this.addAddressRecords(service, endpoint, RType.AAAA, addAdditional);
            response.addAdditional(service.serviceNSECRecord(), service.addressNSECRecord());
          }
        }
      }
    }

    return response;
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
      const ulaRecord = service.aaaaUniqueLocalRecord(endpoint.interface);

      let addedAny = false;
      if (record) {
        addedAny = dest(record);
      }
      if (routableRecord) {
        const added = dest(routableRecord);
        addedAny = addedAny || added;
      }
      if (ulaRecord) {
        const added = dest(ulaRecord);
        addedAny = addedAny || added;
      }

      return addedAny;
    } else {
      assert.fail("Illegal argument!");
    }
  }

}
