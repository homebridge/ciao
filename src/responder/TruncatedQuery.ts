/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import { EventEmitter } from "events";
import { DNSPacket } from "../coder/DNSPacket";
import Timeout = NodeJS.Timeout;

export const enum TruncatedQueryResult {
  ABORT = 1,
  AGAIN_TRUNCATED = 2,
  FINISHED = 3,
}

export const enum TruncatedQueryEvent {
  TIMEOUT = "timeout",
}

export declare interface TruncatedQuery {

  on(event: "timeout", listener: () => void): this;

  emit(event: "timeout"): boolean;

}

export class TruncatedQuery extends EventEmitter {

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
    this.packet.combineWith(packet);

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
      this.removeAllListeners();

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
    this.removeAllListeners();
  }

}
