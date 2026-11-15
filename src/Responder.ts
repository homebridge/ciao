import assert from "assert";
import createDebug from "debug";
import { setMaxListeners } from "events";
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
  TimedSendResult,
} from "./MDNSServer";
import { InterfaceName, NetworkManagerEvent, NetworkUpdate } from "./NetworkManager";
import { Announcer } from "./responder/Announcer";
import { Prober } from "./responder/Prober";
import { QueryResponse, RecordAddMethod } from "./responder/QueryResponse";
import { QueuedResponse } from "./responder/QueuedResponse";
import { TruncatedQuery, TruncatedQueryEvent, TruncatedQueryResult } from "./responder/TruncatedQuery";
import { ERR_INTERFACE_NOT_FOUND, errorMessage } from "./util/errors";
import { sortedInsert } from "./util/sorted-array";
import Timeout = NodeJS.Timeout;
import { SERVICE_TYPE_ENUMERATION_NAME } from "./dns-sd";

const debug = createDebug("ciao:Responder");

const queuedResponseComparator = (a: QueuedResponse, b: QueuedResponse) => {
  return a.estimatedTimeToBeSent - b.estimatedTimeToBeSent;
};

const enum ConflictType { // RFC 6762 6.6.
  NO_CONFLICT,
  CONFLICTING_RDATA, // we must do conflict resolution
  CONFLICTING_TTL,
}

export type ResponderOptions = {
  /**
   * @private
   */
  periodicBroadcasts?: boolean;
  /**
   * @private
   */
  ignoreUnicastResponseFlag?: boolean;
} & MDNSServerOptions;

/**
 * A Responder instance represents a running MDNSServer and a set of advertised services.
 *
 * It will handle any service related operations, like advertising, sending goodbye packets or sending record updates.
 * It handles answering questions arriving at the multicast address.
 */
export class Responder implements PacketHandler {

  /**
   * @private
   */
  public static readonly SERVICE_TYPE_ENUMERATION_NAME = SERVICE_TYPE_ENUMERATION_NAME;

  private static readonly INSTANCES: Map<string, Responder> = new Map();

  private readonly server: MDNSServer;
  /**
   * The tail of the advertisement queue. It orders the probe steps so that one Prober runs at a time, and it is fulfilled whatever a step did,
   * so the outcome of one advertisement never reaches the next.
   */
  private promiseChain: Promise<void>;
  /**
   * Aborted once the last reference shuts the Responder down. A queued advertisement reads it at its turn and is cancelled, and every delay
   * the Responder waits on settles early when it aborts.
   */
  private readonly shutdownController = new AbortController();

  private refCount = 1;
  private optionsString = "";
  /**
   * The Promise of the {@link shutdown} call that released the last reference, set once the Responder is shut down.
   */
  private shutdownPromise?: Promise<void>;

  /**
   * Announced services is indexed by the {@link dnsLowerCase} if the fqdn (as of RFC 1035 3.1).
   * As soon as the probing step is finished the service is added to the announced services Map.
   */
  private readonly announcedServices: Map<string, CiaoService> = new Map();
  /**
   * map representing all our shared PTR records.
   * Typically, we hold stuff like '_services._dns-sd._udp.local' (RFC 6763 9.), '_hap._tcp.local'.
   * Also, pointers for every subtype like '_printer._sub._http._tcp.local' are inserted here.
   *
   * For every pointer we may hold multiple entries (like multiple services can advertise on _hap._tcp.local).
   * The key as well as all values are {@link dnsLowerCase}
   */
  private readonly servicePointer: Map<string, string[]> = new Map();

  /* The attempts to probe or announce a service that failed in a row. A failed attempt is retried every 2 seconds and logged to debug only, as the first
   * retry usually succeeds. At the fifth failure in a row one warning goes to the console, so a service that can never be advertised, such as one whose
   * records fit no packet, is not retried in silence for good. An announcement that gets through starts the count again.
   */
  private static readonly RETRY_WARNING_ATTEMPTS = 5;
  private static readonly failedAttempts: WeakMap<CiaoService, number> = new WeakMap();

  private readonly truncatedQueries: Map<string, TruncatedQuery> = new Map(); // indexed by <ip>:<port>:<interface>
  private readonly delayedMulticastResponses: QueuedResponse[] = [];

  private currentProber?: Prober;

  private readonly ignoreUnicastResponseFlag?: boolean;
  private broadcastInterval?: Timeout;

  /**
   * Refer to {@link getResponder} in the index file
   *
   * @private should not be used directly. Please use the getResponder method defined in index file.
   */
  public static getResponder(options?: ResponderOptions): Responder {
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

  private constructor(options?: ResponderOptions) {
    // Every pending delay listens on the shutdown signal, and more than ten services retrying at once is a normal day, not a leak, so the default
    // listener cap and its warning do not apply to it.
    setMaxListeners(0, this.shutdownController.signal);

    this.server = new MDNSServer(this, options);
    this.promiseChain = this.start();

    this.server.getNetworkManager().on(NetworkManagerEvent.NETWORK_UPDATE, this.handleNetworkUpdate.bind(this));

    this.ignoreUnicastResponseFlag = options?.ignoreUnicastResponseFlag;
    if (options?.periodicBroadcasts) {
      this.broadcastInterval = setTimeout(this.handlePeriodicBroadcasts.bind(this), 30000).unref();
    }
  }

  private handlePeriodicBroadcasts() {
    this.broadcastInterval = undefined;

    debug("Sending periodic announcement on " + Array.from(this.server.getNetworkManager().getInterfaceMap().keys()).join(", "));

    const boundInterfaceNames = Array.from(this.server.getBoundInterfaceNames());

    // One question per service type that is announced, whatever the type, so the broadcast covers every service and not those of one type alone.
    const questions = Array.from(new Set(Array.from(this.announcedServices.values(), service => service.getTypePTR())),
      typePTR => new Question(typePTR, QType.PTR, false));

    for (const networkInterface of this.server.getNetworkManager().getInterfaceMap().values()) {
      const responses: QueryResponse[] = [];

      for (const question of questions) {
        if (boundInterfaceNames.includes(networkInterface.name)) {
          responses.push(...this.answerQuestion(question, {
            port: 5353,
            address: networkInterface.ipv4Netaddress!,
            interface: networkInterface.name,
          }));
        }
        if (boundInterfaceNames.includes(networkInterface.name + "/6")) {
          responses.push(...this.answerQuestion(question, {
            port: 5353,
            address: networkInterface.ipv6!,
            interface: networkInterface.name + "/6",
          }));
        }
      }

      QueryResponse.combineResponses(responses);

      // The responses go out on the IPv4 socket when it is bound and on the IPv6 socket otherwise. With neither bound there are no responses, so a send
      // never names an absent socket.
      const socketName = boundInterfaceNames.includes(networkInterface.name) ? networkInterface.name : networkInterface.name + "/6";

      for (const response of responses) {
        if (!response.hasAnswers()) {
          continue;
        }

        this.server.sendResponse(response.asPacket(), socketName);
      }
    }

    this.broadcastInterval = setTimeout(this.handlePeriodicBroadcasts.bind(this), Math.random() * 3000 + 27000).unref();
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

    return service;
  }

  /**
   * This method should be called when you want to unpublish all service exposed by this Responder.
   * This method SHOULD be called before the node application exists, so any host on the
   * network is informed of the shutdown of this machine.
   * Calling the shutdown method is mandatory for a clean termination (sending goodbye packets).
   *
   * The shutdown method must be called ONCE for every call of {@link getResponder} that returned this instance. A call on a Responder that is already
   * shut down changes nothing and returns the Promise of the call that shut it down.
   *
   * @returns The Promise settles once every goodbye has settled and the server has shut down. It resolves when every goodbye was sent, and otherwise
   * rejects with the first goodbye that failed, taking the services in the order they were announced. It resolves immediately if any other users
   * have a reference to this Responder instance.
   */
  public shutdown(): Promise<void> {
    // A Responder that is shut down has left INSTANCES, and its options may name a newer Responder there by now, which a second run of the code below would
    // remove from the table while it is in use.
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.refCount--;
    if (this.refCount > 0) {
      return Promise.resolve();
    }

    return (this.shutdownPromise = this.shutdownNow());
  }

  private shutdownNow(): Promise<void> {

    this.shutdownController.abort();

    if (this.currentProber) {
      // Services which are in Probing step aren't included in announcedServices Map
      // thus we need to cancel them as well
      this.currentProber.cancel();
    }

    if (this.broadcastInterval) {
      clearTimeout(this.broadcastInterval);
    }

    for (const response of this.delayedMulticastResponses) {
      response.cancel();
    }
    this.delayedMulticastResponses.splice(0);

    Responder.INSTANCES.delete(this.optionsString);

    debug("Shutting down Responder...");

    const promises: Promise<void>[] = [];
    for (const service of this.announcedServices.values()) {
      promises.push(this.unpublishService(service));
    }

    // Every goodbye settles before the server shuts down, so one failure never closes the sockets under the goodbyes still being sent, and the first
    // failure is passed on once the server is down.
    return Promise.allSettled(promises).then(results => {
      this.server.shutdown();

      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) {
        return Promise.reject(failure.reason);
      }
    });
  }

  public getAnnouncedServices(): IterableIterator<CiaoService> {
    return this.announcedServices.values();
  }

  private start(): Promise<void> {
    return this.server.bind();
  }

  /* A delay bound to the lifetime of this Responder. Its timer is unref'd, so a pending retry never holds the process open, and shutdown settles it
   * early, so whatever waits on it runs at once and meets the step guard in advertiseService rather than outliving the Responder. A delay asked for
   * after shutdown settles at once for the same reason. It uses the global setTimeout rather than timers/promises, because jest's fake timers drive
   * only the global one.
   */
  private delay(milliseconds: number): Promise<void> {
    const signal = this.shutdownController.signal;

    return new Promise(resolve => {
      if (signal.aborted) {
        resolve();
        return;
      }

      // The timer and the abort listener each end the delay, and whichever runs first removes the other, so no listener outlives its delay.
      let timer: Timeout | undefined = undefined;
      const settle = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        resolve();
      };

      timer = setTimeout(settle, milliseconds).unref();
      signal.addEventListener("abort", settle);
    });
  }

  /**
   * Retries an advertisement whose probing or announcing failed, after a delay. The retry stops once the service has left UNANNOUNCED, because a later
   * advertisement covers it by then, and re-entering advertiseService would cancel that advertisement's announcer, so the callback it carries is called
   * instead.
   */
  private static noteFailedAttempt(service: CiaoService, step: "probing" | "announcing", reason: unknown): void {
    const attempts = (Responder.failedAttempts.get(service) ?? 0) + 1;

    Responder.failedAttempts.set(service, attempts);

    if (attempts === Responder.RETRY_WARNING_ATTEMPTS) {
      console.warn(`CIAO: [${service.getFQDN()}] Failed ${step} ${attempts} times in a row, so the service is not advertised. `
        + `It is retried every 2 seconds. Last reason: ${errorMessage(reason)}`);
    }
  }

  private retryAdvertisement(service: CiaoService, callback: PublishCallback): Promise<void> {
    return this.delay(2000).then(() => {
      if (service.serviceState !== ServiceState.UNANNOUNCED) {
        callback();
        return;
      }

      return this.advertiseService(service, callback);
    });
  }

  private advertiseService(service: CiaoService, callback: PublishCallback): Promise<void> {
    if (service.serviceState === ServiceState.ANNOUNCED) {
      throw new Error("Can't publish a service that is already announced. Received " + service.serviceState + " for service " + service.getFQDN());
    } else if (service.serviceState === ServiceState.PROBING) {
      // A second advertisement of a probing service joins the one in flight rather than probing again. The tail settles once every step queued so far has
      // settled, the one probing this service among them, whatever their outcome, while the retry of a failed attempt stays with the caller that started it.
      return this.promiseChain.then(() => callback());
    } else if (service.serviceState === ServiceState.ANNOUNCING) {
      assert(service.currentAnnouncer, "Service is in state ANNOUNCING though has no linked announcer!");
      if (service.currentAnnouncer!.isSendingGoodbye()) {
        return Responder.goodbyeSettled(service, service.currentAnnouncer!.awaitAnnouncement()).then(() => this.advertiseService(service, callback));
      } else {
        /* Cancelling an announcement leaves the service UNANNOUNCED, and the advertisement starts over. Cancelling the single packet that corrects a ttl
         * (see handleResponse) leaves it ANNOUNCED instead, and advertising it again is refused as for any announced service. That refusal is thrown, and
         * here nothing above would catch it, so it is handed to the caller, whose advertise() rejects with it.
         */
        return service.currentAnnouncer!.cancel().then(() => {
          try {
            return this.advertiseService(service, callback);
          } catch (error) {
            callback(error instanceof Error? error: new Error(String(error)));
          }
        });
      }
    }

    debug("[%s] Going to advertise service...", service.getFQDN()); // TODO include restricted addresses and stuff

    // multicast loopback is not enabled for our sockets, though we do some stuff, so Prober will handle potential
    // name conflicts with our own services:
    //  - One Responder will always run ONE prober: no need to handle simultaneous probe tiebreaking
    //  - Prober will call the Responder to generate responses to its queries to
    //      resolve name conflicts the same way as with other services on the network

    /* The probe step reports this advertisement's outcome to the continuation below, while the tail stored as promiseChain only orders the steps and is
     * fulfilled whatever the step did, so a cancelled, destroyed or failed advertisement never skips or fails the ones queued after it. The step resolves
     * to whether it probed.
     */
    const step = this.promiseChain.then((): boolean | Promise<boolean> => {
      // Shutdown, or an end() or destroy() that withdrew the advertisement while it waited, cancels it at its turn.
      if (this.shutdownController.signal.aborted || !service.hasAdvertisementIntent()) {
        throw Prober.CANCEL_REASON;
      }

      // A service that left UNANNOUNCED while this step waited is covered by the advertisement that moved it on, so this one settles without probing.
      if (service.serviceState !== ServiceState.UNANNOUNCED) {
        return false;
      }

      service.rebuildServiceRecords();
      return this.probe(service).then(() => true);
    });

    this.promiseChain = step.then(() => undefined, () => undefined);

    return step.then(probed => {
      if (!probed) {
        callback();
        return;
      }

      if (service.isDestroyed()) {
        service.serviceState = ServiceState.UNANNOUNCED;
        callback();
        return;
      }

      // we are not returning the promise returned by announced here, only PROBING is synchronized
      this.announce(service).then(() => {
        Responder.failedAttempts.delete(service);
      }).catch(reason => {
        // handle announce errors
        // debug, not console: this retries itself in 2 seconds and usually succeeds, so it is
        // not something the consumer can act on. Whatever actually broke - a socket or bind
        // error - is still reported loudly by MDNSServer, which owns it. Logging every retry
        // here as well put a line on the console every 2 seconds forever (homebridge/ciao#72).
        debug(`[${service.getFQDN()}] failed announcing with reason: ${reason}. Trying again in 2 seconds!`);
        Responder.noteFailedAttempt(service, "announcing", reason);
        return this.retryAdvertisement(service, () => {
          // The caller was called back when announcing began, so the retry has nobody left to settle.
        });
      }).catch(error => {
        // Terminal handler: the recursive advertiseService retry above is fire-and-forget, so any
        // rejection from the retry chain (probe failure, socket error, repeated cancellation) has
        // no caller to .catch it and would otherwise surface as an unhandled rejection and crash
        // the host process. See homebridge/ciao#69.
        console.error(`[${service.getFQDN()}] giving up advertising after retry: ${error?.message ?? error}`);
      });

      callback(); // service is considered announced. After the call to the announce() method the service state is set to ANNOUNCING
    }, reason => {
      /* Probe errors are handled here, on the continuation of the step, rather than inside the step. A catch inside the step would turn a cancel into a
       * fulfilled step, and the handler above would then announce an advertisement that was withdrawn...here a cancel settles the caller without
       * announcing. Any other reason is a probe query that could not be sent: it is retried after a delay and logged to debug rather than the console,
       * for the reason the announce retry above gives.
       */
      if (reason === Prober.CANCEL_REASON) {
        callback();
        return;
      }

      debug(`[${service.getFQDN()}] failed probing with reason: ${reason}. Trying again in 2 seconds!`);
      Responder.noteFailedAttempt(service, "probing", reason);
      return this.retryAdvertisement(service, callback);
    });
  }

  private async republishService(service: CiaoService, callback: PublishCallback, delayAnnounce = false): Promise<void> {
    if (service.serviceState !== ServiceState.ANNOUNCED && service.serviceState !== ServiceState.ANNOUNCING) {
      throw new Error("Can't unpublish a service which isn't announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Readvertising service...", service.getFQDN());

    if (service.serviceState === ServiceState.ANNOUNCING) {
      assert(service.currentAnnouncer, "Service is in state ANNOUNCING though has no linked announcer!");

      const promise = service.currentAnnouncer!.isSendingGoodbye()
        ? Responder.goodbyeSettled(service, service.currentAnnouncer!.awaitAnnouncement())
        : service.currentAnnouncer!.cancel();

      // A cancelled announcement leaves the service UNANNOUNCED, ready to be advertised again. The single packet that corrects a ttl (see handleResponse)
      // leaves it ANNOUNCED when cancelled, so the republish starts over from there, where advertiseService would refuse an announced service.
      return promise.then(() => service.serviceState === ServiceState.ANNOUNCED
        ? this.republishService(service, callback, delayAnnounce)
        : this.advertiseService(service, callback));
    }

    // first of all remove it from our advertisedService Map and remove all the maintained PTRs
    this.clearService(service);
    service.serviceState = ServiceState.UNANNOUNCED; // the service is now considered unannounced

    // and now we basically just announce the service by doing probing and the 'announce' step
    if (delayAnnounce) {
      return this.delay(1000)
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
      let goodbye: Promise<void>;

      if (service.serviceState === ServiceState.ANNOUNCING) {
        assert(service.currentAnnouncer, "Service is in state ANNOUNCING though has no linked announcer!");
        if (!service.currentAnnouncer!.isSendingGoodbye()) {
          return service.currentAnnouncer!.cancel().then(() => {
            service.serviceState = ServiceState.ANNOUNCED; // unpublishService requires announced state
            return this.unpublishService(service, callback);
          });
        }

        // A goodbye is already being sent, so this caller settles with it.
        goodbye = service.currentAnnouncer!.awaitAnnouncement();
      } else {
        debug("[%s] Removing service from the network", service.getFQDN());
        this.clearService(service);
        service.serviceState = ServiceState.UNANNOUNCED;

        goodbye = this.goodbye(service);
      }

      // With no caller to settle, as on shutdown, the goodbye's own outcome is returned, so a failure reaches whoever awaits it.
      return callback ? Responder.goodbyeSettled(service, goodbye).then(() => callback()) : goodbye;
    } else if (service.serviceState === ServiceState.PROBING) {
      debug("[%s] Canceling probing", service.getFQDN());
      if (this.currentProber && this.currentProber.getService() === service) {
        this.currentProber.cancel();
        this.currentProber = undefined;
      }

      service.serviceState = ServiceState.UNANNOUNCED;
    }

    if (typeof callback === "function") {
      callback();
    }
    return Promise.resolve();
  }

  private clearService(service: CiaoService): void {
    const serviceFQDN = service.getLowerCasedFQDN();
    const typePTR = service.getLowerCasedTypePTR();
    const subtypePTRs = service.getLowerCasedSubtypePTRs(); // possibly undefined

    // The type enumeration holds one pointer per service type, shared by every service of that type, so it stays while another service of the type is
    // announced and goes with the last one.
    let typeStillAnnounced = false;
    for (const other of this.announcedServices.values()) {
      if (other !== service && other.getLowerCasedTypePTR() === typePTR) {
        typeStillAnnounced = true;
        break;
      }
    }

    if (!typeStillAnnounced) {
      this.removePTR(Responder.SERVICE_TYPE_ENUMERATION_NAME, typePTR);
    }
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
    // when updating we just repeat the 'announce' step
    if (service.serviceState !== ServiceState.ANNOUNCED) { // different states are already handled in CiaoService where this event handler is fired
      throw new Error("Cannot update txt of service which is not announced yet. Received " + service.serviceState + " for service " + service.getFQDN());
    }

    debug("[%s] Updating %d record(s) for given service!", service.getFQDN(), response.answers.length + (response.additionals?.length || 0));

    // sendResponseBroadcast builds and encodes the packet before it sends, and throws when the records cannot be encoded, a record set too big for one packet
    // among them. This is reached from the txt debounce timer, where an escaping throw is an uncaught exception that ends the host process, so the throw
    // takes the path of a rejected broadcast below.
    let broadcast: Promise<TimedSendResult[]>;
    try {
      broadcast = this.server.sendResponseBroadcast(response, service);
    } catch (error) {
      broadcast = Promise.reject(error);
    }

    // TODO we should do a announcement at this point "in theory"
    broadcast.then(results => {
      const failRatio = SendResultFailedRatio(results);
      if (failRatio === 1) {
        console.log(SendResultFormatError(results, `Failed to send records update for '${service.getFQDN()}'`));
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
    }, reason => {
      // A broadcast that rejects, or that threw while building its packet (see above), ends here. Without
      // this handler the rejection would surface as an unhandled promise rejection — same orphan-rejection
      // footgun that bit the advertise/goodbye paths in homebridge/ciao#69.
      console.log(`[${service.getFQDN()}] failed to broadcast records update: ${reason?.message ?? reason}`);
      if (callback) {
        callback(reason instanceof Error ? reason : new Error(String(reason)));
      }
    });
  }

  private goodbye(service: CiaoService): Promise<void> {
    assert(service.currentAnnouncer === undefined, "Service " + service.getFQDN() + " is already announcing!");

    service.serviceState = ServiceState.ANNOUNCING;

    // if another service still publishes this hostname, its address records must outlive this service (#20).
    // On shutdown the services are cleared one after another, so the last one still withdraws them.
    let keepAddressRecords = false;
    for (const other of this.announcedServices.values()) {
      if (other.getLowerCasedHostname() === service.getLowerCasedHostname() && other.sharesAddressRecordsWith(service)) {
        keepAddressRecords = true;
        break;
      }
    }

    const announcer = new Announcer(this.server, service, {
      repetitions: 1,
      goodbye: true,
      keepAddressRecords: keepAddressRecords,
    });
    service.currentAnnouncer = announcer;

    return announcer.announce().then(() => {
      service.serviceState = ServiceState.UNANNOUNCED;
      service.currentAnnouncer = undefined;
    }, reason => {
      // just assume unannounced. we won't be answering anymore, so the record will be flushed from cache sometime.
      service.serviceState = ServiceState.UNANNOUNCED;
      service.currentAnnouncer = undefined;
      // Mirror the behaviour of private announce() above: a goodbye that races with shutdown/republish
      // and gets cancelled is not an error — the caller was tearing the service down anyway. Forwarding
      // CANCEL_REASON here would force every shutdown path to attach a .catch for a non-error condition,
      // which is the orphan-rejection footgun that bit homebridge/ciao#69.
      if (reason !== Announcer.CANCEL_REASON) {
        return Promise.reject(reason);
      }
    });
  }

  /* Settles once a goodbye has settled, whatever its outcome, a failure logged rather than passed on. The service is off the network whatever the
   * outcome, as a record nobody answers for anymore expires from every cache, so whoever waits on the goodbye goes on as though it had been sent.
   */
  private static goodbyeSettled(service: CiaoService, goodbye: Promise<void>): Promise<void> {
    return goodbye.catch(reason => {
      console.log(`[${service.getFQDN()}] failed goodbye with reason: ${reason}.`);
    });
  }

  private handleNetworkUpdate(change: NetworkUpdate): void {
    for (const service of this.announcedServices.values()) {
      service.handleNetworkInterfaceUpdate(change);
    }
  }

  /**
   * @private method called by the MDNSServer when an incoming query needs to be handled
   */
  handleQuery(packet: DNSPacket, endpoint: EndpointInfo): void {
    const start = Date.now();

    const endpointId = endpoint.address + ":" + endpoint.port + ":" + endpoint.interface; // used to match truncated queries

    const previousQuery = this.truncatedQueries.get(endpointId);
    if (previousQuery) {
      const truncatedQueryResult = previousQuery.appendDNSPacket(packet);

      switch (truncatedQueryResult) {
        case TruncatedQueryResult.ABORT: // returned when we detect, that continuously TC queries are sent
          this.truncatedQueries.delete(endpointId);
          debug("[%s] Aborting to wait for more truncated queries. Waited a total of %d ms receiving %d queries",
            endpointId, previousQuery.getTotalWaitTime(), previousQuery.getArrivedPacketCount());
          return;
        case TruncatedQueryResult.AGAIN_TRUNCATED:
          debug("[%s] Received a query marked as truncated, waiting for more to arrive", endpointId);
          return; // wait for the next packet
        case TruncatedQueryResult.FINISHED:
          this.truncatedQueries.delete(endpointId);
          packet = previousQuery.getPacket(); // replace packet with the complete deal

          debug("[%s] Last part of the truncated query arrived. Received %d packets taking a total of %d ms",
            endpointId, previousQuery.getArrivedPacketCount(), previousQuery.getTotalWaitTime());
          break;
      }
    } else if (packet.flags.truncation) {
      // RFC 6763 18.5 truncate flag indicates that additional known-answer records follow shortly
      debug("Received truncated query from " + JSON.stringify(endpoint) + " waiting for more to come!");

      const truncatedQuery = new TruncatedQuery(packet);
      this.truncatedQueries.set(endpointId, truncatedQuery);
      truncatedQuery.on(TruncatedQueryEvent.TIMEOUT, () => {
        // RFC 6762 7.2: the querier had 400 to 500 ms to send the rest of its known answers. None came, so the query is answered with what arrived.
        debug("[%s] Timeout passed since the last truncated query was received. Answering the %d packets received in %d ms.",
          endpointId, truncatedQuery.getArrivedPacketCount(), truncatedQuery.getTotalWaitTime());
        this.truncatedQueries.delete(endpointId);

        // This runs from the query's timer, not from MDNSServer's packet handler, whose try/catch covers a query answered at once. A throw here would be an
        // uncaught exception that ends the process, and a send throws when the interface the query came in on has gone while we waited.
        try {
          this.answerQuery(truncatedQuery.getPacket(), endpoint, Date.now());
        } catch (error) {
          if (error instanceof Error && error.name === ERR_INTERFACE_NOT_FOUND) {
            debug("[%s] The answer to the truncated query was dropped, as the network interface %s is no longer available!", endpointId, endpoint.interface);
          } else {
            console.warn(`CIAO: Failed to answer a truncated query from ${endpointId}: ${errorMessage(error)}`);
          }
        }
      });

      return; // wait for the next query
    }

    this.answerQuery(packet, endpoint, start);
  }

  // Answers a query that has arrived whole: a single packet, or every packet of a truncated query joined into one.
  private answerQuery(packet: DNSPacket, endpoint: EndpointInfo, start: number): void {
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
    const multicastResponses: QueryResponse[] = [];
    const unicastResponses: QueryResponse[] = [];

    // gather answers for all the questions
    packet.questions.forEach(question => {
      const responses = this.answerQuestion(question, endpoint, packet.answers);

      if (isUnicastQuerier || question.unicastResponseFlag && !this.ignoreUnicastResponseFlag) {
        unicastResponses.push(...responses);
      } else {
        multicastResponses.push(...responses);
      }
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
        // only add questions to the first packet (will be combined anyway) and we must ensure
        // each packet stays unique in its records
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
      const time = Date.now() - start;
      debug("Sending response via unicast to %s (took %d ms): %s", JSON.stringify(endpoint), time, unicastResponse.asString(udpPayloadSize));
    }

    for (const multicastResponse of multicastResponses) {
      if (!multicastResponse.hasAnswers()) {
        continue;
      }

      if ((multicastResponse.containsSharedAnswer() || packet.questions.size > 1) && !isProbeQuery) {
        // We must delay the response on an interval of 20-120ms if we can't assure that we are the only one responding (shared records).
        // This is also the case if there are multiple questions. If multiple questions are asked
        // we probably could not answer them all (because not all of them were directed to us).
        // All those conditions are overridden if this is a probe query. To those queries we must respond instantly!

        const time = Date.now() - start;
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
            const time = Date.now() - start;
            sentWithLaterPacket = true;
            debug("Multicast response on interface %s containing unique records (took %d ms) was combined with response which is sent out later",
              endpoint.interface, time);
            break;
          }
        }

        if (!sentWithLaterPacket) {
          this.server.sendResponse(multicastResponse.asPacket(), endpoint.interface);
          const time = Date.now() - start;
          debug("Sending response via multicast on network %s (took %d ms): %s", endpoint.interface, time, multicastResponse.asString(udpPayloadSize));
        }
      }
    }
  }

  /**
   * @private method called by the MDNSServer when an incoming response needs to be handled
   */
  handleResponse(packet: DNSPacket, endpoint: EndpointInfo): void {
    // any questions in a response must be ignored RFC 6762 6.

    if (this.currentProber) { // if there is a probing process running currently, just forward all messages to it
      this.currentProber.handleResponse(packet, endpoint);
    }

    for (const service of this.announcedServices.values()) {
      let conflictingRData = false;
      let ttlConflicts = 0; // we currently do a full-blown announcement with all records, we could in the future track which records have invalid ttl

      for (const record of packet.answers.values()) {
        const type = Responder.checkRecordConflictType(service, record, endpoint);
        if (type === ConflictType.CONFLICTING_RDATA) {
          conflictingRData = true;
          break; // we will republish in any case
        } else if (type === ConflictType.CONFLICTING_TTL) {
          ttlConflicts++;
        }
      }

      if (!conflictingRData) {
        for (const record of packet.additionals.values()) {
          const type = Responder.checkRecordConflictType(service, record, endpoint);
          if (type === ConflictType.CONFLICTING_RDATA) {
            conflictingRData = true;
            break; // we will republish in any case
          } else if (type === ConflictType.CONFLICTING_TTL) {
            ttlConflicts++;
          }
        }
      }


      if (conflictingRData) {
        this.republishService(service, error => {
          if (error) {
            // A republish retries a failed advertisement itself and calls back with no error. Should one ever arrive it is reported here, and what to do
            // about it is left to the application: a library does not end the process it runs in.
            console.warn(`CIAO: [${service.getFQDN()}] Failed to re-announce the service after a conflict: ${error.stack ?? error}`);
          }
        }, true).catch(error => {
          // Terminal handler: nothing awaits the republish, so a rejection would otherwise go unhandled and end the host process.
          console.warn(`CIAO: [${service.getFQDN()}] Failed to resolve a conflict: ${error?.message ?? error}`);
        });
      } else if (ttlConflicts && !service.currentAnnouncer) {
        service.serviceState = ServiceState.ANNOUNCING; // all code above doesn't expect an Announcer object in state ANNOUNCED

        const announcer = new Announcer(this.server, service, {
          repetitions: 1, // we send exactly one packet to correct any ttl values in neighbouring caches
        });
        service.currentAnnouncer = announcer;

        announcer.announce().then(() => {
          service.currentAnnouncer = undefined;
          service.serviceState = ServiceState.ANNOUNCED;
        }, reason => {
          service.currentAnnouncer = undefined;
          service.serviceState = ServiceState.ANNOUNCED;

          if (reason === Announcer.CANCEL_REASON) {
            return; // nothing to worry about
          }

          console.warn("When trying to resolve a ttl conflict on the network, we were unable to send our response packet: " + reason.message);
        });
      }
    }
  }

  private static checkRecordConflictType(service: CiaoService, record: ResourceRecord, endpoint: EndpointInfo): ConflictType {
    // RFC 6762 9. Conflict Resolution:
    //    A conflict occurs when a Multicast DNS responder has a unique record
    //    for which it is currently authoritative, and it receives a Multicast
    //    DNS response message containing a record with the same name, rrtype
    //    and rrclass, but inconsistent rdata.  What may be considered
    //    inconsistent is context-sensitive, except that resource records with
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
      return ConflictType.NO_CONFLICT;
    }

    const recordName = record.getLowerCasedName();

    if (recordName === service.getLowerCasedFQDN()) {
      if (record.type === RType.SRV) {
        const srvRecord = record as SRVRecord;
        if (srvRecord.getLowerCasedHostname() !== service.getLowerCasedHostname()) {
          debug("[%s] Noticed conflicting record on the network. SRV with hostname: %s", service.getFQDN(), srvRecord.hostname);
          return ConflictType.CONFLICTING_RDATA;
        } else if (srvRecord.port !== service.getPort()) {
          debug("[%s] Noticed conflicting record on the network. SRV with port: %s", service.getFQDN(), srvRecord.port);
          return ConflictType.CONFLICTING_RDATA;
        }

        if (srvRecord.ttl < SRVRecord.DEFAULT_TTL/2) {
          return ConflictType.CONFLICTING_TTL;
        }
      } else if (record.type === RType.TXT) {
        const txtRecord = record as TXTRecord;
        // a TXT record can't hold zero strings, so an empty one goes out as a single empty string
        // (RFC 6763 6.1.) and that's how it comes back. Comparing it to the service's [] instead made
        // a service without TXT data take its own record, echoed back by anything, for a conflict
        const txt = service.getTXT().length === 0 ? [Buffer.alloc(0)] : service.getTXT();

        if (txt.length !== txtRecord.txt.length) { // length differs, can't be the same data
          debug("[%s] Noticed conflicting record on the network. TXT with differing data length", service.getFQDN());
          return ConflictType.CONFLICTING_RDATA;
        }

        for (let i = 0; i < txt.length; i++) {
          const buffer0 = txt[i];
          const buffer1 = txtRecord.txt[i];

          if (Buffer.compare(buffer0, buffer1) !== 0) {
            debug("[%s] Noticed conflicting record on the network. TXT with differing data.", service.getFQDN());
            return ConflictType.CONFLICTING_RDATA;
          }
        }

        if (txtRecord.ttl < TXTRecord.DEFAULT_TTL/2) {
          return ConflictType.CONFLICTING_TTL;
        }
      }
    } else if (recordName === service.getLowerCasedHostname()) {
      if (record.type === RType.A) {
        const aRecord = record as ARecord;

        if (!service.hasAddress(aRecord.ipAddress)) {
          // if the service doesn't expose the listed address we have a conflict
          debug("[%s] Noticed conflicting record on the network. A with ip address: %s", service.getFQDN(), aRecord.ipAddress);
          return ConflictType.CONFLICTING_RDATA;
        }

        if (aRecord.ttl < ARecord.DEFAULT_TTL/2) {
          return ConflictType.CONFLICTING_TTL;
        }
      } else if (record.type === RType.AAAA) {
        const aaaaRecord = record as AAAARecord;

        if (!service.hasAddress(aaaaRecord.ipAddress)) {
          // if the service doesn't expose the listed address we have a conflict
          debug("[%s] Noticed conflicting record on the network. AAAA with ip address: %s", service.getFQDN(), aaaaRecord.ipAddress);
          return ConflictType.CONFLICTING_RDATA;
        }

        if (aaaaRecord.ttl < AAAARecord.DEFAULT_TTL/2) {
          return ConflictType.CONFLICTING_TTL;
        }
      }
    } else if (record.type === RType.PTR) {
      const ptrRecord = record as PTRRecord;

      if (recordName === service.getLowerCasedTypePTR()) {
        if (ptrRecord.getLowerCasedPTRName() === service.getLowerCasedFQDN() && ptrRecord.ttl < PTRRecord.DEFAULT_TTL/2) {
          return ConflictType.CONFLICTING_TTL;
        }
      } else if (recordName === Responder.SERVICE_TYPE_ENUMERATION_NAME) {
        // nothing to do here, I guess
      } else {
        const subTypes = service.getLowerCasedSubtypePTRs();
        if (subTypes && subTypes.includes(recordName)
          && ptrRecord.getLowerCasedPTRName() === service.getLowerCasedFQDN() && ptrRecord.ttl < PTRRecord.DEFAULT_TTL/2) {
          return ConflictType.CONFLICTING_TTL;
        }
      }
    }

    return ConflictType.NO_CONFLICT;
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
          if (error instanceof Error && error.name === ERR_INTERFACE_NOT_FOUND) {
            debug("Multicast response (delayed %dms) was cancelled as the network interface %s is no longer available!",
              Math.round(response.getTimeSinceCreation()), interfaceName);
          } else {
            // This runs from a timer, where a throw is an uncaught exception that ends the process.
            // Losing one delayed response is not worth that - the querier simply asks again
            console.warn(`CIAO: Failed to send a delayed response on ${interfaceName}: ${errorMessage(error)}`);
          }
        }
      });
    }
  }

  private answerQuestion(question: Question, endpoint: EndpointInfo, knownAnswers?: Map<string, ResourceRecord>): QueryResponse[] {
    // RFC 6762 6: The determination of whether a given record answers a given question
    //    is made using the standard DNS rules: the record name must match the
    //    question name, the record rrtype must match the question qtype unless
    //    the qtype is "ANY" (255) or the rrtype is "CNAME" (5), and the record
    //    rrclass must match the question qclass unless the qclass is "ANY" (255).
    // The CNAME exception is a record's rrtype, and ciao publishes no CNAME record, so a CNAME question matches only records of its own type.

    if (question.class !== QClass.IN && question.class !== QClass.ANY) {
      // We just publish answers with IN class. So only IN or ANY questions classes will match
      return [];
    }

    const serviceResponses: QueryResponse[] = [];
    let metaQueryResponse: QueryResponse | undefined = undefined;

    if (question.type === QType.PTR || question.type === QType.ANY) {
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
              const response = Responder.answerServiceQuestion(service, question, endpoint, knownAnswers);
              if (response.hasAnswers()) {
                serviceResponses.push(response);
              }
            }
          } else {
            if (!metaQueryResponse) {
              metaQueryResponse = new QueryResponse(knownAnswers);
              serviceResponses.unshift(metaQueryResponse);
            }

            // it's probably question for PTR '_services._dns-sd._udp.local'
            // the PTR will just point to something like '_hap._tcp.local' thus no additional records need to be included
            metaQueryResponse.addAnswer(new PTRRecord(question.name, data));
            // we may send out meta queries on interfaces where there aren't any services, because they are
            //  restricted to other interfaces.
          }
        }

        return serviceResponses; // if we got in this if-body, it was a pointer name and we handled it correctly
      }

      // We won't actually respond to reverse address queries (names under "in-addr.arpa" and "ip6.arpa").
      // This typically confuses responders like avahi, which then over and over try to increment the hostname.
    }

    for (const service of this.announcedServices.values()) {
      if (!service.advertisesOnInterface(endpoint.interface)) {
        continue;
      }

      const response = Responder.answerServiceQuestion(service, question, endpoint, knownAnswers);
      if (response.hasAnswers()) {
        serviceResponses.push(response);
      }
    }

    return serviceResponses;
  }

  private static answerServiceQuestion(service: CiaoService, question: Question, endpoint: EndpointInfo, knownAnswers?: Map<string, ResourceRecord>): QueryResponse {
    // This assumes to be called from answerQuestion inside the Responder class and thus that certain
    // preconditions or special cases are already covered.
    // For one, we assume classes are already matched.

    const response = new QueryResponse(knownAnswers);

    const loweredQuestionName = question.getLowerCasedName();
    const askingAny = question.type === QType.ANY;
    // The address records and the address NSEC are keyed by the interface's own name, not its IPv6 socket's ("<name>/6").
    const interfaceName = endpoint.interface.endsWith("/6") ? endpoint.interface.slice(0, -2) : endpoint.interface;

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
          this.addAddressRecords(service, interfaceName, RType.A, addAdditional);
          this.addAddressRecords(service, interfaceName, RType.AAAA, addAdditional);
          response.addAdditional(service.serviceNSECRecord());
          this.addAddressNSEC(service, interfaceName, addAdditional);
        }
      }
    } else if (loweredQuestionName === service.getLowerCasedFQDN()) {
      if (askingAny) {
        response.addAnswer(service.txtRecord());
        const addedSrv = response.addAnswer(service.srvRecord());

        if (addedSrv) {
          // RFC 6763 12.2: include additionals: a, aaaa
          this.addAddressRecords(service, interfaceName, RType.A, addAdditional);
          this.addAddressRecords(service, interfaceName, RType.AAAA, addAdditional);
          response.addAdditional(service.serviceNSECRecord());
          this.addAddressNSEC(service, interfaceName, addAdditional);
        }
      } else if (question.type === QType.SRV) {
        const added = response.addAnswer(service.srvRecord());

        if (added) {
          // RFC 6763 12.2: include additionals: a, aaaa
          this.addAddressRecords(service, interfaceName, RType.A, addAdditional);
          this.addAddressRecords(service, interfaceName, RType.AAAA, addAdditional);
          response.addAdditional(service.serviceNSECRecord(true));
          this.addAddressNSEC(service, interfaceName, addAdditional);
        }
      } else if (question.type === QType.TXT) {
        response.addAnswer(service.txtRecord());
        response.addAdditional(service.serviceNSECRecord());

        // RFC 6763 12.3: not any other additionals
      } else {
        // RFC 6762 6.1: the instance name is uniquely owned and holds its SRV and TXT records alone, so a question for any other type is answered with the
        // service NSEC, which asserts as much.
        response.addAnswer(service.serviceNSECRecord());
      }
    } else if (loweredQuestionName === service.getLowerCasedHostname() || loweredQuestionName + "local." === service.getLowerCasedHostname()) {
      // The NSEC lists the address types the service holds on this interface, built from its records there, and none exists for an interface it holds
      // neither type on, where the hostname holds no record to answer with or about.
      const addressNSEC = service.addressNSECRecord(interfaceName);

      if (askingAny) {
        this.addAddressRecords(service, interfaceName, RType.A, addAnswer);
        this.addAddressRecords(service, interfaceName, RType.AAAA, addAnswer);
        if (addressNSEC) {
          response.addAdditional(addressNSEC);
        }
      } else if (question.type === QType.A && addressNSEC?.listsType(RType.A)) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        const added = this.addAddressRecords(service, interfaceName, RType.A, addAnswer);
        if (added) {
          this.addAddressRecords(service, interfaceName, RType.AAAA, addAdditional);
        }

        response.addAdditional(addressNSEC); // always add the negative response, always assert dominance
      } else if (question.type === QType.AAAA && addressNSEC?.listsType(RType.AAAA)) {
        // RFC 6762 6.2 When a Multicast DNS responder places an IPv4 or IPv6 address record
        //    (rrtype "A" or "AAAA") into a response message, it SHOULD also place
        //    any records of the other address type with the same name into the
        //    additional section, if there is space in the message.
        const added = this.addAddressRecords(service, interfaceName, RType.AAAA, addAnswer);
        if (added) {
          this.addAddressRecords(service, interfaceName, RType.A, addAdditional);
        }

        response.addAdditional(addressNSEC); // always add the negative response, always assert dominance
      } else if (addressNSEC) {
        /* RFC 6762 6.1: the hostname is uniquely owned, so a question for a type it holds no record of on this interface, CNAME and every other type beside
         * A and AAAA as much as an address type the interface does not carry, is answered with the address NSEC, which asserts that nonexistence.
         */
        response.addAnswer(addressNSEC);
      }
    } else if (service.getLowerCasedSubtypePTRs()) {
      if (askingAny || question.type === QType.PTR) {
        const dnsLowerSubTypes = service.getLowerCasedSubtypePTRs()!;
        const index = dnsLowerSubTypes.indexOf(loweredQuestionName);

        if (index !== -1) { // we have a subtype for the question
          const records = service.subtypePtrRecords();
          const record = records![index];
          assert(loweredQuestionName === record.name, "Question Name didn't match selected sub type ptr record!");

          const added = response.addAnswer(record);
          if (added) {
            // RFC 6763 12.1: include additionals: srv, txt, a, aaaa
            response.addAdditional(service.txtRecord(), service.srvRecord());
            this.addAddressRecords(service, interfaceName, RType.A, addAdditional);
            this.addAddressRecords(service, interfaceName, RType.AAAA, addAdditional);
            response.addAdditional(service.serviceNSECRecord());
            this.addAddressNSEC(service, interfaceName, addAdditional);
          }
        }
      }
    }

    return response;
  }

  /**
   * This method is a helper method to reduce the complexity inside {@link answerServiceQuestion}.
   * The method calculates which A and AAAA records to be added for a given interface using
   * the records from the provided {@code service}.
   * It will add the records by calling the provided {@code dest} method.
   *
   * @param {CiaoService} service - service which records to be use
   * @param {InterfaceName} interfaceName - the interface's own name, which the address records are keyed by
   * @param {RType.A | RType.AAAA} type - defines the type of records to be added
   * @param {RecordAddMethod} dest - defines the destination which the records should be added
   * @returns true if any records got added
   */
  private static addAddressRecords(service: CiaoService, interfaceName: InterfaceName, type: RType.A | RType.AAAA, dest: RecordAddMethod): boolean {
    if (type === RType.A) {
      const record = service.aRecord(interfaceName);
      return record? dest(record): false;
    } else if (type === RType.AAAA) {
      const record = service.aaaaRecord(interfaceName);
      const routableRecord = service.aaaaRoutableRecord(interfaceName);
      const ulaRecord = service.aaaaUniqueLocalRecord(interfaceName);

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

  /**
   * Adds the address NSEC of an interface through the provided {@code dest} method, when the service holds an address record there.
   *
   * @param {CiaoService} service - service which records to be use
   * @param {InterfaceName} interfaceName - the interface's own name, which the address records are keyed by
   * @param {RecordAddMethod} dest - defines the destination which the record should be added
   * @returns true if the record got added
   */
  private static addAddressNSEC(service: CiaoService, interfaceName: InterfaceName, dest: RecordAddMethod): boolean {
    const record = service.addressNSECRecord(interfaceName);
    return record? dest(record): false;
  }

}
