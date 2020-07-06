import assert from "assert";
import createDebug from "debug";
import { CiaoService, ServiceState } from "../CiaoService";
import { ResourceRecord } from "../coder/ResourceRecord";
import { MDNSServer, SendCallback } from "../MDNSServer";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:Announcer");

export interface AnnouncerOptions {
  /**
   * Defines how often the announcement should be sent.
   */
  repetitions?: number;
  /**
   * If set to true, goodbye packets will be sent (ttl will be set to zero on all records)
   */
  goodbye?: boolean;
}

/**
 * This class is used to execute the announce process for a given service as define in RFC 6762 8.3.
 *
 * The Multicast DNS responder MUST send at least two unsolicited
 * responses, one second apart.  To provide increased robustness against
 * packet loss, a responder MAY send up to eight unsolicited responses,
 * provided that the interval between unsolicited responses increases by
 * at least a factor of two with every response sent.
 *
 */
export class Announcer {

  public static readonly CANCEL_REASON = "cancelled";

  private readonly server: MDNSServer;
  private readonly service: CiaoService;

  private readonly repetitions: number = 1;
  private readonly announceIntervalIncreaseFactor = 2; // RFC states a factor of AT LEAST two (could be higher as it seems)
  private readonly goodbye: boolean = false;

  private timer?: Timeout;
  private promise?: Promise<void>;
  private promiseResolve?: (value?: void | PromiseLike<void>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private promiseReject?: (reason?: any) => void;

  private sentAnnouncements = 0;
  private sentLastAnnouncement = false;
  private nextInterval = 1000;

  constructor(server: MDNSServer, service: CiaoService, options: AnnouncerOptions) {
    assert(server, "server must be defined");
    assert(service, "service must be defined");
    this.server = server;
    this.service = service;

    if (options) {
      if (options.repetitions !== undefined) {
        this.repetitions = options.repetitions;
      }
      if (options.goodbye) {
        this.goodbye = true;
      }
    }

    assert(this.repetitions > 0 && this.repetitions <= 8, "repetitions must in [1;8]");
  }

  public announce(): Promise<void> {
    debug("[%s] Sending %s for service", this.service.getFQDN(), this.goodbye? "goodbye": "announcement");

    // could happen that the txt record was updated while probing.
    // just to be sure to announce all the latest data, we will rebuild the services.
    this.service.rebuildServiceRecords();

    return (this.promise = new Promise((resolve, reject) => {
      this.promiseResolve = resolve;
      this.promiseReject = reject;

      this.timer = setTimeout(this.sendAnnouncement.bind(this), 0);
      this.timer.unref();
    }));
  }

  public cancel(): void {
    debug("Canceling %s for '%s'", this.goodbye? "goodbye": "announcement", this.service.getFQDN());
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.promiseReject!(Announcer.CANCEL_REASON);
  }

  public hasSentLastAnnouncement(): boolean {
    return this.sentLastAnnouncement;
  }

  public async awaitAnnouncement(): Promise<void> {
    await this.promise;
  }

  private sendAnnouncement() {
    // minimum required is to send two unsolicited responses, one second apart
    // we could announce up to 8 times in total (time between messages must increase by two every message)

    debug("Sending %s number %d for '%s'", this.goodbye? "goodbye": "announcement", this.sentAnnouncements + 1, this.service.getFQDN());

    // we rebuild every time,
    const records = [
      this.service.ptrRecord(), ...this.service.subtypePtrRecords(),
      this.service.srvRecord(), this.service.txtRecord(),
      // A and AAAA records are added below when sending. Which records get added depends on the network the announcement happens for
    ];

    if (this.goodbye) {
      for (const record of records) {
        record.ttl = 0; // setting ttl to zero to indicate "goodbye"
      }
    } else {
      records.push(this.service.metaQueryPtrRecord());
    }

    if (this.sentAnnouncements + 1 >= this.repetitions) {
      this.sentLastAnnouncement = true;
    }

    Announcer.sendResponseAddingAddressRecords(this.server, this.service, records, false, error => {
      if (error) {
        debug("Failed to send %s request for '%s'. Encountered error: " + error.stack, this.goodbye? "goodbye": "announcement", this.service.getFQDN());
        this.promiseReject!(error);
        return;
      }

      if (this.service.serviceState !== ServiceState.ANNOUNCING) {
        debug("Service '%s' is no longer in announcing state. Stopping. (Received %s)", this.service.getFQDN(), this.service.serviceState);
        return;
      }

      this.sentAnnouncements++;
      if (this.sentAnnouncements >= this.repetitions) {
        this.promiseResolve!();
      } else {
        this.timer = setTimeout(this.sendAnnouncement.bind(this), this.nextInterval);
        this.timer.unref();

        this.nextInterval *= this.announceIntervalIncreaseFactor;
      }
    });
  }

  private static sendResponseAddingAddressRecords(server: MDNSServer, service: CiaoService, records: ResourceRecord[], goodbye: boolean, callback?: SendCallback): void {
    let iterations = server.getNetworkCount();
    const encounteredErrors: Error[] = [];

    for (const name of server.getInterfaceNames()) {
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
        server.sendResponse({ answers: answer }, name);
      } else {
        server.sendResponse({ answers: answer }, name, error => {
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
