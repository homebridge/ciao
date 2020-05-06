import {DnsResponse, MDNSServer, PacketHandler, ServerOptions} from "./MDNSServer";
import {AnswerRecord, Class, DecodedDnsPacket, QuestionRecord, Type} from "@homebridge/dns-packet";
import {AddressInfo} from "net";
import {CiaoService, ServiceEvent, ServiceOptions, ServiceState} from "./CiaoService";
import * as domainFormatter from "./util/domain-formatter";
import {InstanceNameDomain, PTRQueryDomain, SubTypedNameDomain} from "./util/domain-formatter";
import {Prober} from "./Prober";
import dnsEqual, {dnsLowerCase} from "./util/dns-equal";

export class Responder implements PacketHandler {

  private readonly server: MDNSServer;
  private bound = false;

  // announcedServices is indexed by dnsLowerCase(service.fqdn) (as of RFC 1035 3.1)
  private readonly announcedServices: Map<string, CiaoService> = new Map();

  private currentProber?: Prober;

  constructor(options?: ServerOptions) {
    this.server = new MDNSServer(this, options);
  }

  public start(): Promise<void> {
    if (this.bound) {
      throw new Error("Server is already bound!");
    }

    this.bound = true;
    return this.server.bind();
  }

  public advertiseService(options: ServiceOptions): Promise<void> {
    const service = new CiaoService(options);

    // we have multicast loopback enabled, if there where any conflicting names, they would be resolved by the Prober

    // TODO check if there is already a probing process ongoing. If so => enqueue

    // TODO check if the server needs to be bound (for easier API)

    return this.probe(service).then(() => this.announce(service));
  }

  /**
   * This method should be called when you want to unpublish all service exposed by this Responder.
   * This method SHOULD be called before the node application exists, so any host on the
   * network is informed of the shutdown of this machine.
   */
  public shutdown(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const service of this.announcedServices.values()) {
      promises.push(this.unpublishService(service)); // TODO check if we can combine all those unpublish request into one packet (at least less packets)
    }

    // eslint-disable-next-line
    return Promise.all(promises).then(() => {});
  }

  private unpublishService(service: CiaoService): Promise<void> { // TODO unpublish all services on node app exit
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.fqdn);
    }

    this.announcedServices.delete(dnsLowerCase(service.fqdn));
    service.removeAllListeners();
    service.serviceState = ServiceState.UNANNOUNCED;

    return this.goodbye(service);
  }

  private probe(service: CiaoService): Promise<void> {
    if (service.serviceState !== ServiceState.UNANNOUNCED) {
      throw new Error("Can't probe for a service which is announced already. Received " + service.serviceState + " for service " + service.fqdn);
    }

    service.serviceState = ServiceState.PROBING;

    this.currentProber = new Prober(this.server, service);
    return this.currentProber.probe()
      .then(() => {
        this.currentProber = undefined;
        service.serviceState = ServiceState.ANNOUNCED; // we consider it announced now

        return this.announce(service).then(() => {
          service.on(ServiceEvent.UPDATED, this.update.bind(this, service));
          service.on(ServiceEvent.UNPUBLISH, this.unpublishService.bind(this, service));

          this.announcedServices.set(dnsLowerCase(service.fqdn), service);
        });
      }, reason => { // TODO somehow forward the message?
        service.serviceState = ServiceState.UNANNOUNCED;
        this.currentProber = undefined;
      });
  }

  private announce(service: CiaoService, recordOverride?: AnswerRecord[]): Promise<void> {
    if (service.serviceState !== ServiceState.ANNOUNCED) {
      throw new Error("Cannot announce service which is not announced yet. Received " + service.serviceState + " for service " + service.fqdn);
    }

    const answers: AnswerRecord[] = recordOverride || [service.recordPTR(), service.recordSRV(), service.recordTXT(), ...service.recordsAandAAAA()];

    // all records which where probed to be unique and are not shared must set the flush bit
    answers.forEach(answer => {
      if (answer.type !== Type.PTR) { // pointer is the only shared record we expose
        answer.flush = true;
      }
    });

    return new Promise(resolve => {
      // minimum required is to send two unsolicited responses, one second apart
      this.server.sendResponse({ answers: answers }, () => {
        setTimeout(() => { // publish it a second time after 1 second
          this.server.sendResponse({ answers: answers }, () => {
            resolve();
          });
        }, 1000); // TODO we could announce up to 8 times in total (time between messages must increas by two every message)
      });
    });
  }

  private update(service: CiaoService, type: Type) {
    // when updating we just repeat the announce step
    // for shared records we MUST send a goodbye message first (is currently not the case)

    // TODO we SHOULD NOT update more than ten times per minute (this is not the case??)

    switch (type) {
      case Type.TXT:
        // the only updated thing we support right now are txt changes
        this.announce(service, [service.recordTXT()]);
        break;
      // TODO support A and AAAA updates
    }
  }

  private goodbye(service: CiaoService, recordOverride?: AnswerRecord[]): Promise<void> {
    const answers: AnswerRecord[] = recordOverride || [service.recordPTR(), service.recordSRV(), service.recordTXT(), ...service.recordsAandAAAA()];
    // TODO do we need to track which A and AAAA were sent previously for sending a goodbye? (seems like it, see below)

    // TODO response packet, giving the same resource record name, rrtype,
    //    rrclass, and rdata, but an RR TTL of zero.

    answers.forEach(answer => answer.ttl = 0); // setting ttl to zero to indicate "goodbye"

    return new Promise<void>(resolve => {
      this.server.sendResponse({ answers: answers }, resolve);
    });
  }

  private resolveConflict(service: CiaoService) {
    // TODO implement
  }

  handleQuery(packet: DecodedDnsPacket, rinfo: AddressInfo): void {
    // TODO To protect the network against excessive packet flooding due to
    //    software bugs or malicious attack, a Multicast DNS responder MUST NOT
    //    (except in the one special case of answering probe queries) multicast
    //    a record on a given interface until at least one second has elapsed
    //    since the last time that record was multicast on that particular
    //    interface.

    const answers: AnswerRecord[] = [];
    const additionals: AnswerRecord[] = [];

    // TODO probe queries have proposed records in the authority section

    // eslint-disable-next-line
    let delayResponse = false; // TODO describe and set
    let unicastResponse = false;
    let proberNeedsTiebreaking = false;

    // TODO for query messages containing more than one question, all
    //    (non-defensive) answers SHOULD be randomly delayed in the range
    //    20-120 ms, or 400-500 ms if the TC (truncated) bit is set.  This is
    //    because when a query message contains more than one question, a
    //    Multicast DNS responder cannot generally be certain that other
    //    responders will not also be simultaneously generating answers to
    //    other questions in that query message.  (Answers defending a name, in
    //    response to a probe for that name, are not subject to this delay rule
    //    and are still sent immediately.) => I don't think this is needed?

    // gather answers for all the questions
    packet.questions.forEach(question => {
      if (question.flag_qu) {
        unicastResponse = true;
      }

      if (this.currentProber && dnsEqual(this.currentProber.service.fqdn, question.name)) {
        // if we are currently probing and receiving a query which is also a probing query
        // which matches the desired name we run the tiebreaking algorithm to decide on the winner
        proberNeedsTiebreaking = true;
      }

      const serviceAnswers = this.answerQuestion(question, rinfo);
      answers.push(...serviceAnswers);

      if (question.type !== Type.ANY && question.type !== Type.CNAME) { // ANY or CNAME all records are included anyways
        // check if we want to include additionals according to RFC 6764 12.
        serviceAnswers.forEach(answer => {
          if (answer.type === Type.PTR) { // RFC 6763 12.1.
            const service = this.announcedServices.get(answer.data);

            if (service) {
              const adds: AnswerRecord[] = [service.recordSRV(), service.recordTXT(), ...service.recordsAandAAAA(rinfo)];
              adds.forEach(answer => answer.flush = true);
              // TODO we may include negative response for A and AAAA

              additionals.push(...adds);
            }
          } else if (answer.type === Type.SRV) { // RFC 6763 12.2.
            const service = this.announcedServices.get(answer.name);

            if (service) {
              const adds: AnswerRecord[] = service.recordsAandAAAA(rinfo);
              adds.forEach(answer => answer.flush = true);
              // TODO we may include negative response for A and AAAA

              additionals.push(...adds);
            }
          }
        });
      }
    });

    if (proberNeedsTiebreaking) {
      this.currentProber!.doTiebreaking(packet, rinfo);
    }

    // TODO implement known answer suppression

    if (answers.length === 0) {
      // if we would know that we own the record for the given question
      // but the record currently does not exist, we would need
      // to respond with negative answers as of RFC 6762 6.
      // We do this for A and AAAA records. But for the rest we can't be sure i guess?
      return;
    }

    const response: DnsResponse = {
      // responses must not include questions RFC 6762 6.
      answers: answers,
      additionals: additionals,
    };

    if (rinfo.port !== 5353) { // TODO use a constant here?
      // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
      //  * MUSTS: response via unicast, repeat query ID, repeat questions, clear cache flush bit
      //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism
      unicastResponse = true;
      response.id = packet.id;
      response.questions = packet.questions;

      response.answers.forEach(answers => {
        answers.flush = false;
        answers.ttl = 10;
      });
      response.additionals?.forEach(answers => {
        answers.flush = false;
        answers.ttl = 10;
      });
    }

    // TODO randomly delay the response to avoid collisions (even for unicast responses)
    this.server.sendResponse(response, unicastResponse? rinfo: undefined);
  }

  handleResponse(packet: DecodedDnsPacket, rinfo: AddressInfo): void {
    // any questions in a response must be ignored RFC 6762 6.

    if (this.currentProber) { // if there is a probing process running currently, just forward all messages to it
      this.currentProber.handleResponse(packet, rinfo);
    }

    // TODO conflict resolution if we detect a response with shares name, rrtype and rrclass but rdata is DIFFERENT!
    //  if indentical: If the TTL of B's resource record given in the message is less
    //         than half the true TTL from A's point of view, then A MUST mark
    //         its record to be announced via multicast.  Queriers receiving
    //         the record from B would use the TTL given by B and, hence, may
    //         delete the record sooner than A expects.  By sending its own
    //         multicast response correcting the TTL, A ensures that the record
    //         will be retained for the desired time.
  }

  private answerQuestion(question: QuestionRecord, rinfo: AddressInfo): AnswerRecord[] {
    const answers: AnswerRecord[] = [];

    // RFC 6762 6: The determination of whether a given record answers a given question
    //    is made using the standard DNS rules: the record name must match the
    //    question name, the record rrtype must match the question qtype unless
    //    the qtype is "ANY" (255) or the rrtype is "CNAME" (5), and the record
    //    rrclass must match the question qclass unless the qclass is "ANY" (255).

    if (question.class !== Class.IN && question.class !== Class.ANY) {
      return answers; // We just publish answers with IN class. So only IN or ANY questions classes wil match
    }

    switch (question.type) {
      case Type.PTR: { // SubTypedNameDomain
        const parsed: SubTypedNameDomain | InstanceNameDomain | PTRQueryDomain = domainFormatter.parseFQDN(question.name);

        if ("subtype" in parsed) {
          // TODO add support for subtype queries
          break;
        } else if ("name" in parsed) { // InstanceNameDomain
          if (domainFormatter.isServiceTypeEnumeration(parsed)) { // RFC 6763 9. special case "_services._dns-sd._udp.<Domain>"
            for (const service of this.announcedServices.values()) {
              if (service.domain !== parsed.domain) { // the domains must match
                continue;
              }

              answers.push(service.recordPTR());
            }
          } else { // it's a string like "MyDevice._hap._tcp.local"
            // we use the lowercase here as of RFC 1035 3.1. (dns names need to compared case insensitive)
            const service = this.announcedServices.get(dnsLowerCase(question.name));

            if (service) {
              answers.push(service.recordPTR());
            }
          }
        } else { // PTRQueryDomain
          for (const service of this.announcedServices.values()) {
            if (service.domain !== parsed.domain || service.protocol !== parsed.protocol || service.type !== parsed.type) {
              continue;
            }

            if (service) {
              answers.push(service.recordPTR());
            }
          }
        }
        break;
      }
      default:
        for (const service of this.announcedServices.values()) {
          const serviceAnswers = service.answerQuestion(question, rinfo);
          serviceAnswers.forEach(answer => {
            if (answer.type !== Type.PTR) {
              answer.flush = true;
            }
          });

          answers.push(...serviceAnswers);
        }
        break;
    }

    return answers;
  }

}
