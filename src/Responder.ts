import { AnswerRecord, Class, DecodedDnsPacket, QuestionRecord, Type } from "@homebridge/dns-packet";
import assert from "assert";
import deepEqual from "fast-deep-equal";
import {
  CiaoService,
  InternalServiceEvent,
  PublishCallback,
  ServiceOptions,
  ServiceState,
  UnpublishCallback,
} from "./CiaoService";
import { DnsResponse, EndpointInfo, MDNSServer, PacketHandler, SendCallback, MDNSServerOptions } from "./MDNSServer";
import { Prober } from "./Prober";
import { dnsLowerCase } from "./util/dns-equal";
import createDebug from "debug";

const debug = createDebug("ciao:Responder");

interface CalculatedAnswer {
  answers: AnswerRecord[];
  additionals: AnswerRecord[];
}

export class Responder implements PacketHandler {

  public static readonly SERVICE_TYPE_ENUMERATION_NAME = "_services._dns-sd._udp.local";

  private readonly server: MDNSServer;
  private promiseChain: Promise<void>;

  private bound = false;

  // announcedServices is indexed by dnsLowerCase(service.fqdn) (as of RFC 1035 3.1)
  private readonly announcedServices: Map<string, CiaoService> = new Map();
  /*
   * map representing all out shared PTR records.
   * Typically we hold stuff like '_services._dns-sd._udp.local' (RFC 6763 9.), '_hap._tcp.local'.
   * Also pointers for every subtype like '_printer._sub._http._tcp.local' are inserted here.
   *
   * For every pointer we may hold multiple entries (like multiple services can advertise on _hap._tcp.local).
   */
  private readonly servicePointer: Map<string, string[]> = new Map();

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
      promises.push(this.unpublishService(service)); // TODO check if we can combine all those unpublish request into one packet (at least less packets) TODO what's the max size?
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

    const records: AnswerRecord[] = [
      service.ptrRecord(), ...service.subtypePtrRecords(),
      service.srvRecord(), service.txtRecord(),
      // A and AAAA records are added below when sending. Which records get added depends on the interface the announcement happens
    ];

    if (this.announcedServices.size === 0) {
      records.push(service.metaQueryPtrRecord());
    }

    return new Promise((resolve, reject) => {
      // minimum required is to send two unsolicited responses, one second apart
      // we could announce up to 8 times in total (time between messages must increase by two every message)

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

  private handleServiceRecordUpdate(service: CiaoService, records: AnswerRecord[], callback?: (error?: Error | null) => void): void {
    // when updating we just repeat the announce step
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Updating %d record(s) for given service!", service.getFQDN(), records.length);

    this.server.sendResponseBroadcast( { answers: records }, error => {
      if (error) {
        callback && callback(error);
        return;
      }

      setTimeout(() => {
        // TODO check if cicumstances may have changed by now?
        this.server.sendResponseBroadcast({ answers: records }, callback);
      }, 1000).unref();
    });
  }

  private goodbye(service: CiaoService, recordOverride?: AnswerRecord[]): Promise<void> {
    const records: AnswerRecord[] = recordOverride || [
      service.ptrRecord(), ...service.subtypePtrRecords(),
      service.srvRecord(), service.txtRecord(),
    ];

    records.forEach(answer => answer.ttl = 0); // setting ttl to zero to indicate "goodbye"

    return new Promise((resolve, reject) => {
      this.sendResponseAddingAddressRecords(service, records, true, error => error? reject(error): resolve());
    });
  }

  handleQuery(packet: DecodedDnsPacket, endpoint: EndpointInfo): void {
    if (packet.flag_tc) {
      // RFC 6763 18.5 flag indicates that additional known-answer records follow shortly
      // TODO wait here for those additional known-answer records READ RFC 6762 7.2
      throw new Error("Truncated messages are currently unsupported");
    }

    const multicastAnswers: AnswerRecord[] = [];
    const multicastAdditionals: AnswerRecord[] = [];
    const unicastAnswers: AnswerRecord[] = [];
    const unicastAdditionals: AnswerRecord[] = [];

    // gather answers for all the questions
    packet.questions.forEach(question => {
      const answer = this.answerQuestion(question, endpoint);

      // TODO maybe check that we are not adding the same answer twice, if multiple questions get overlapping answers
      if (question.flag_qu) { // question requests unicast response
        unicastAnswers.push(...answer.answers);
        unicastAdditionals.push(...answer.additionals);
      } else {
        multicastAnswers.push(...answer.answers);
        multicastAdditionals.push(...answer.additionals);
      }
    });

    if (this.currentProber) {
      this.currentProber.handleQuery(packet);
    }

    // do known answer suppression according to RFC 6762 7.1.
    packet.answers.forEach(record => {
      Responder.removeKnownAnswers(record, multicastAnswers);
      Responder.removeKnownAnswers(record, multicastAdditionals);
      Responder.removeKnownAnswers(record, unicastAnswers);
      Responder.removeKnownAnswers(record, unicastAdditionals);
    });

    const multicastResponse: DnsResponse = {
      // responses must not include questions RFC 6762 6.
      answers: multicastAnswers,
      additionals: multicastAdditionals,
    };
    const unicastResponse: DnsResponse = {
      answers: unicastAnswers,
      additionals: unicastAdditionals,
    };

    if (endpoint.port !== MDNSServer.MDNS_PORT) {
      // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
      //  * MUSTS: response via unicast, repeat query ID, repeat questions, clear cache flush bit
      //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism
      unicastAnswers.push(...multicastAnswers);
      unicastAdditionals.push(...multicastAdditionals);
      multicastAnswers.splice(0, multicastAnswers.length);
      multicastAdditionals.splice(0, multicastAdditionals.length);

      unicastResponse.id = packet.id;
      unicastResponse.questions = packet.questions;

      unicastResponse.answers.forEach(answers => {
        answers.flush = false;
        answers.ttl = 10;
      });
      unicastResponse.additionals?.forEach(answers => {
        answers.flush = false;
        answers.ttl = 10;
      });
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
    if (unicastAnswers.length > 0 || multicastAdditionals.length > 0) {
      this.server.sendResponse(unicastResponse, endpoint);
    }
    if (multicastAnswers.length > 0 || multicastAdditionals.length > 0) {
      // TODO To protect the network against excessive packet flooding due to
      //    software bugs or malicious attack, a Multicast DNS responder MUST NOT
      //    (except in the one special case of answering probe queries) multicast
      //    a record on a given interface until at least one second has elapsed
      //    since the last time that record was multicast on that particular
      //    interface.
      this.server.sendResponseBroadcast(multicastResponse);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleResponse(packet: DecodedDnsPacket, endpoint: EndpointInfo): void {
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

  private answerQuestion(question: QuestionRecord, endpoint: EndpointInfo): CalculatedAnswer {
    const answers: AnswerRecord[] = [];
    const additionals: AnswerRecord[] = [];

    const collectedAnswers: CalculatedAnswer[] = [];

    // RFC 6762 6: The determination of whether a given record answers a given question
    //    is made using the standard DNS rules: the record name must match the
    //    question name, the record rrtype must match the question qtype unless
    //    the qtype is "ANY" (255) or the rrtype is "CNAME" (5), and the record
    //    rrclass must match the question qclass unless the qclass is "ANY" (255).

    if (question.class !== Class.IN && question.class !== Class.ANY) {
      // We just publish answers with IN class. So only IN or ANY questions classes will match
      return {
        answers: answers,
        additionals: [],
      };
    }

    switch (question.type) {
      case Type.PTR: {
        const destinations = this.servicePointer.get(dnsLowerCase(question.name)); // look up the pointer

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
              answers.push({
                name: question.name,
                type: Type.PTR,
                ttl: 4500, // 75 minutes
                data: data,
              });
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

  private static answerServiceQuestion(service: CiaoService, question: QuestionRecord, endpoint: EndpointInfo): CalculatedAnswer {
    // This assumes to be called from answerQuestion inside the Responder class and thus that certain
    // preconditions or special cases are already covered.
    // For one we assume classes are already matched.

    const answers: AnswerRecord[] = [];
    const additionals: AnswerRecord[] = [];

    const questionName = dnsLowerCase(question.name);
    const askingAny = question.type === Type.ANY || question.type === Type.CNAME;

    // RFC 6762 6.2. In the event that a device has only IPv4 addresses but no IPv6
    //    addresses, or vice versa, then the appropriate NSEC record SHOULD be
    //    placed into the additional section, so that queriers can know with
    //    certainty that the device has no addresses of that kind.
    const nsecTypes: Type[] = []; // collect types for a negative response

    if (questionName === dnsLowerCase(service.getTypePTR())) {
      if (askingAny || question.type === Type.PTR) {
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
      } else if (question.type === Type.SRV) {
        answers.push(service.srvRecord());

        // RFC 6763 12.2: include additionals: a, aaaa
        Responder.addAddressRecords(service, endpoint, additionals, additionals, nsecTypes);
      } else if (question.type === Type.TXT) {
        answers.push(service.txtRecord());

        // RFC 6763 12.3: no not any other additionals
      }
    } else if (questionName === dnsLowerCase(service.getHostname())) {
      if (askingAny) {
        Responder.addAddressRecords(service, endpoint, answers, answers, nsecTypes);
      } else if (question.type === Type.A) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        Responder.addAddressRecords(service, endpoint, answers, additionals, nsecTypes);
      } else if (question.type === Type.AAAA) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        Responder.addAddressRecords(service, endpoint, additionals, answers, nsecTypes);
      }
    } else if (service.getSubtypePTRs()) {
      if (askingAny || question.type === Type.PTR) {
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
      additionals.push({
        name: service.getHostname(),
        type: Type.NSEC,
        ttl: 4500, // ttl of A/AAAA records as this are the only one producing NSEC
        data: {
          nextDomain: service.getHostname(),
          rrtypes: nsecTypes,
        },
      });
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
   * @param {AnswerRecord[]} aDest - array where the A record gets added
   * @param {AnswerRecord[]} aaaaDest - array where all AAAA records get added
   * @param {Type[]} nsecDest - if A or AAAA do not exist the type will be pushed onto this array
   */
  private static addAddressRecords(service: CiaoService, endpoint: EndpointInfo, aDest: AnswerRecord[], aaaaDest: AnswerRecord[], nsecDest: Type[]): void {
    const aRecord = service.aRecord(endpoint.interface);
    const aaaaRecords = service.aaaaRecords(endpoint.interface);

    if (aRecord) {
      aDest.push(aRecord);
    } else {
      nsecDest.push(Type.A);
    }

    if (aaaaRecords && aaaaRecords.length > 0) {
      aaaaDest.push(...aaaaRecords);
    } else {
      nsecDest.push(Type.AAAA);
    }
  }

  private static removeKnownAnswers(knownAnswer: AnswerRecord, records: AnswerRecord[]): void {
    const ids: number[] = [];

    records.forEach(((record, index) => {
      if (knownAnswer.type === record.type && knownAnswer.name === record.name
        && knownAnswer.class === record.class && deepEqual(knownAnswer.data, record.data)) {
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

  private sendResponseAddingAddressRecords(service: CiaoService, records: AnswerRecord[], goodbye: boolean, callback?: SendCallback): void {
    let iterations = this.server.getInterfaceCount();
    const encounteredErrors: Error[] = [];

    for (const networkInterface of this.server.getInterfaces()) {
      const answer: AnswerRecord[] = records.concat([]);

      const aRecord = service.aRecord(networkInterface);
      const aaaaRecords = service.aaaaRecords(networkInterface);

      if (aRecord) {
        if (goodbye) {
          aRecord.ttl = 0;
        }
        answer.push(aRecord);
      }
      if (aaaaRecords) {
        if (goodbye) {
          aaaaRecords.forEach(record => record.ttl = 0);
        }
        answer.push(...aaaaRecords);
      }

      if (!callback) {
        this.server.sendResponse({ answers: answer }, networkInterface);
      } else {
        this.server.sendResponse({ answers: answer }, networkInterface, error => {
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
