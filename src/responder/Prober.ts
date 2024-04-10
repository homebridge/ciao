import assert from "assert";
import createDebug from "debug";
import { CiaoService, ServiceState } from "../CiaoService";
import { DNSPacket, QType } from "../coder/DNSPacket";
import { Question } from "../coder/Question";
import { ResourceRecord } from "../coder/ResourceRecord";
import { EndpointInfo, MDNSServer, SendResultFailedRatio, SendResultFormatError } from "../MDNSServer";
import { Responder } from "../Responder";
import * as tiebreaking from "../util/tiebreaking";
import { rrComparator, TiebreakingResult } from "../util/tiebreaking";
import Timeout = NodeJS.Timeout;

const PROBE_INTERVAL = 250; // 250ms as defined in RFC 6762 8.1.
const LIMITED_PROBE_INTERVAL = 1000;
const debug = createDebug("ciao:Prober");

/**
 * This class is used to execute the probing process for a given service as defined
 * in RFC 6762 8.1.
 * This ensures that we advertise the service under a unique name.
 * It also provides a conflict resolution algorithm if multiple clients probing
 * for the same name are detected.
 */
export class Prober {

  public static readonly CANCEL_REASON = "CIAO PROBING CANCELLED";

  private readonly responder: Responder;
  private readonly server: MDNSServer;
  private readonly service: CiaoService;

  private records: ResourceRecord[] = [];

  private timer?: Timeout;
  private currentInterval: number = PROBE_INTERVAL;
  private promiseResolve?: (value?: void | PromiseLike<void>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private promiseReject?: (reason?: any) => void;

  private serviceEncounteredNameChange = false;
  private sentFirstProbeQuery = false; // we MUST ignore responses received BEFORE the first probe is sent
  private sentQueriesForCurrentTry = 0;
  private sentQueries = 0;

  constructor(responder: Responder, server: MDNSServer, service: CiaoService) {
    assert(responder, "responder must be defined");
    assert(server, "server must be defined");
    assert(service, "service must be defined");
    this.responder = responder;
    this.server = server;
    this.service = service;
  }

  public getService(): CiaoService {
    return this.service;
  }

  /**
   * This method is called to start the actual probing process.
   * Once the service is considered unique on the network and can be announced the promise returns.
   * While probing multiple name changes can happen
   *
   * @returns a promise which returns when the service is considered unique on the network
   */
  public probe(): Promise<void> {
    /*
     * Probing is basically the following process: We send three "probe" queries to check
     * if the desired service name is already on the network.
     * The request are sent with a delay of 250ms between them and the first
     * request starting with a random delay.
     * If we don't receive any response to our requests we consider the probing to be successful
     * and continue with announcing our service.
     */

    debug("Starting to probe for '%s'...", this.service.getFQDN());

    return new Promise((resolve, reject) => {
      this.promiseResolve = resolve;
      this.promiseReject = reject;

      this.timer = setTimeout(this.sendProbeRequest.bind(this), Math.random() * PROBE_INTERVAL);
      this.timer.unref();
    });
  }

  public cancel(): void {
    this.clear();

    this.promiseReject!(Prober.CANCEL_REASON);
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    // reset all values to default (so the Prober can be reused if it wasn't successful)
    this.sentFirstProbeQuery = false;
    this.sentQueriesForCurrentTry = 0;
  }

  /**
   * End the current ongoing probing requests. If
   * @param success
   */
  private endProbing(success: boolean): void {
    // reset all values to default (so the Prober can be reused if it wasn't successful)
    this.clear();

    if (success) {
      debug("Probing for '%s' finished successfully", this.service.getFQDN());
      this.promiseResolve!();

      if (this.serviceEncounteredNameChange) {
        this.service.informAboutNameUpdates();
      }
    }
  }

  private sendProbeRequest(): void {
    if (this.sentQueriesForCurrentTry === 0) { // this is the first query sent, init some stuff
      // RFC 6762 8.2. When a host is probing for a group of related records with the same
      //    name (e.g., the SRV and TXT record describing a DNS-SD service), only
      //    a single question need be placed in the Question Section, since query
      //    type "ANY" (255) is used, which will elicit answers for all records
      //    with that name.  However, for tiebreaking to work correctly in all
      //    cases, the Authority Section must contain *all* the records and
      //    proposed rdata being probed for uniqueness.

      // it states *all* records, though we include ALL A/AAAA records as well, even
      // though it may not be relevant data if the probe query is published on different interfaces.
      // Having the same "format" probed on all interfaces, the simultaneous probe tiebreaking
      // algorithm can work correctly. Otherwise, we would conflict with ourselves in a situation were
      // a device is connected to the same network via Wi-Fi and Ethernet.
      this.records = [
        this.service.srvRecord(), this.service.txtRecord(),
        this.service.ptrRecord(), ...this.service.subtypePtrRecords(),
        ...this.service.allAddressRecords(), //...this.service.allReverseAddressMappings(),
      ].sort(rrComparator); // we sort them for the tiebreaking algorithm
      this.records.forEach(record => record.flushFlag = false);
    }

    if (this.sentQueriesForCurrentTry >= 3) {
      // we sent three requests, and it seems like we weren't canceled, so we have a success right here
      this.endProbing(true);
      return;
    }

    if (this.sentQueries >= 15) {
      this.currentInterval = LIMITED_PROBE_INTERVAL;
    }

    debug("Sending prober query number %d for '%s'...", this.sentQueriesForCurrentTry + 1, this.service.getFQDN());

    assert(this.records.length > 0, "Tried sending probing request for zero record length!");

    const questions = [
      // probes SHOULD be sent with unicast response flag as of the RFC
      // MDNServer might overwrite the QU flag to false, as we can't use unicast if there is another responder on the machine
      new Question(this.service.getFQDN(), QType.ANY, true),
      new Question(this.service.getHostname(), QType.ANY, true),
    ];

    this.server.sendQueryBroadcast({
      questions: questions,
      // TODO certified homekit accessories only include the main service PTR record
      authorities: this.records, // include records we want to announce in authorities to support Simultaneous Probe Tiebreaking (RFC 6762 8.2.)
    }, this.service).then(results => {
      const failRatio = SendResultFailedRatio(results);
      if (failRatio === 1) {
        console.error(SendResultFormatError(results, `Failed to send probe queries for '${this.service.getFQDN()}'`), true);
        this.endProbing(false);
        this.promiseReject!(new Error("Probing failed as of socket errors!"));
        return; // all failed => thus probing failed
      }

      if (failRatio > 0) {
        // some queries on some interfaces failed, but not all. We log that but consider that to be a success
        // at this point we are not responsible for removing stale network interfaces or something

        debug(SendResultFormatError(results, `Some of the probe queries for '${this.service.getFQDN()}' encountered an error`));
        // SEE no return here
      }

      if (this.service.serviceState !== ServiceState.PROBING) {
        debug("Service '%s' is no longer in probing state. Stopping.", this.service.getFQDN());
        return;
      }

      this.sentFirstProbeQuery = true;
      this.sentQueriesForCurrentTry++;
      this.sentQueries++;

      this.timer = setTimeout(this.sendProbeRequest.bind(this), this.currentInterval);
      this.timer.unref();

      this.checkLocalConflicts();
    });
  }

  private checkLocalConflicts() {
    let containsAnswer = false;
    for (const service of this.responder.getAnnouncedServices()) {
      if (service.getLowerCasedFQDN() === this.service.getLowerCasedFQDN() || service.getLowerCasedHostname() === this.service.getLowerCasedHostname()) {
        containsAnswer = true;
        break;
      }
    }

    if (containsAnswer) {
      debug("Probing for '%s' failed as of local service. Doing a name change", this.service.getFQDN());
      this.handleNameChange();
    }
  }

  handleResponse(packet: DNSPacket, endpoint: EndpointInfo): void {
    if (!this.sentFirstProbeQuery || !this.service.advertisesOnInterface(endpoint.interface)) {
      return;
    }

    let containsAnswer = false;
    // search answers and additionals for answers to our probe queries
    for (const record of packet.answers.values()) {
      if (record.getLowerCasedName() === this.service.getLowerCasedFQDN() || record.getLowerCasedName() === this.service.getLowerCasedHostname()) {
        containsAnswer = true;
        break;
      }
    }
    for (const record of packet.additionals.values()) {
      if (record.getLowerCasedName() === this.service.getLowerCasedFQDN() || record.getLowerCasedName() === this.service.getLowerCasedHostname()) {
        containsAnswer = true;
        break;
      }
    }

    if (containsAnswer) { // abort and cancel probes
      debug("Probing for '%s' failed. Doing a name change", this.service.getFQDN());
      this.handleNameChange();
    }
  }

  private handleNameChange() {
    this.endProbing(false); // reset the prober
    this.service.serviceState = ServiceState.UNANNOUNCED;
    this.service.incrementName();
    this.service.serviceState = ServiceState.PROBING;

    this.serviceEncounteredNameChange = true;

    this.timer = setTimeout(this.sendProbeRequest.bind(this), 1000);
    this.timer.unref();
  }

  handleQuery(packet: DNSPacket, endpoint: EndpointInfo): void {
    if (!this.sentFirstProbeQuery || !this.service.advertisesOnInterface(endpoint.interface)) {
      return;
    }

    // if we are currently probing and receiving a query which is also a probing query
    // which matches the desired name we run the tiebreaking algorithm to decide on the winner
    let needsTiebreaking = false;
    for (const question of packet.questions.values()) {
      if (question.getLowerCasedName() === this.service.getLowerCasedFQDN() || question.getLowerCasedName() === this.service.getLowerCasedHostname()) {
        needsTiebreaking = true;
        break;
      }
    }


    if (needsTiebreaking) {
      this.doTiebreaking(packet);
    }
  }

  private doTiebreaking(packet: DNSPacket): void {
    if (!this.sentFirstProbeQuery) { // ignore queries if we are not sending
      return;
    }

    // first of all check if the contents of authorities answers our query
    let conflict = packet.authorities.size === 0;
    for (const record of packet.authorities.values()) {
      if (record.getLowerCasedName() === this.service.getLowerCasedFQDN() || record.getLowerCasedName() === this.service.getLowerCasedHostname()) {
        conflict = true;
        break;
      }
    }
    if (!conflict) {
      return;
    }
    // now run the actual tiebreaking algorithm to decide the winner

    // tiebreaking is actually run pretty often, as we always receive our own packets

    // first of all build our own records
    const answers = this.records; // already sorted
    const opponent = Array.from(packet.authorities.values()).sort(tiebreaking.rrComparator);

    const result = tiebreaking.runTiebreaking(answers, opponent);

    if (result === TiebreakingResult.HOST) {
      debug("'%s' won the tiebreak. We gonna ignore the other probing request!", this.service.getFQDN());
    } else if (result === TiebreakingResult.OPPONENT) {
      debug("'%s' lost the tiebreak. We are waiting a second and try to probe again...", this.service.getFQDN());

      this.endProbing(false); // cancel the current probing

      // wait 1 second and probe again (this is to guard against stale probe packets)
      // If it wasn't a stale probe packet, the other host will correctly respond to our probe queries by then
      this.timer = setTimeout(this.sendProbeRequest.bind(this), 1000);
      this.timer.unref();
    } else {
      //debug("Tiebreaking for '%s' detected exact same records on the network. There is actually no conflict!", this.service.getFQDN());
    }
  }

}
