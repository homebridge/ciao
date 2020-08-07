/**
 * Represents a delay response packet which is going to be sent over multicast.
 */
import { DNSPacket } from "../coder/DNSPacket";
import { InterfaceName } from "../NetworkManager";
import { QueryResponse } from "./QueryResponse";
import Timeout = NodeJS.Timeout;

export class QueuedResponse {

  public static readonly MAX_DELAY = 500; // milliseconds

  private readonly packet: DNSPacket;
  private readonly interfaceName: InterfaceName;

  private timeOfCreation = new Date().getTime(); // epoch time millis
  estimatedTimeToBeSent = 0; // epoch time millis
  private delay = -1;
  private timer?: Timeout;

  delayed?: boolean; // indicates that this object is invalid, got delayed (combined with another object)

  constructor(packet: DNSPacket, interfaceName: InterfaceName) {
    this.packet = packet;
    this.interfaceName = interfaceName;
  }

  public getPacket(): DNSPacket {
    return this.packet;
  }

  /**
   * This method returns the total delay of the represented dns response packet.
   * If this QueuedResponse consists of already combined packets
   * (meaning other packets already got delayed in order to be sent out with this packet),
   * the totalDelay will represent the maximum delay of any contained packet.
   *
   * @returns The total delay.
   */
  public getTimeSinceCreation(): number {
    return new Date().getTime() - this.timeOfCreation;
  }

  public getTimeTillSent(): number {
    return Math.max(0, this.estimatedTimeToBeSent - new Date().getTime());
  }

  public calculateRandomDelay(): void {
    this.delay = Math.random() * 100 + 20; // delay of 20ms - 120ms
    this.estimatedTimeToBeSent = new Date().getTime() + this.delay;
  }

  public scheduleResponse(callback: () => void): void {
    this.timer = setTimeout(callback, this.delay);
    this.timer.unref(); // timer doesn't prevent termination
  }

  public delayWouldBeInTimelyManner(next: QueuedResponse): boolean {
    const delay = next.estimatedTimeToBeSent - this.timeOfCreation;
    return delay <= QueuedResponse.MAX_DELAY;
  }

  /**
   * Combines this queue response packet with the {@code next} queued response packet if those can be combined.
   * Packets can be combined if the udpPayloadSize allows for it AND if the current packet
   * won't be delayed more than 500 ms from it's time of creation AND the packets get sent on the same interface.
   *
   * @param next - A queued response which is schedule AFTER the current queued response.
   * @returns {@code true} will be returned if the queued response was combined with the specified {@code next} response.
   */
  public combineWithNextPacketIfPossible(next: QueuedResponse): boolean {
    // below check, which is commented out would be necessary, current implementation will check that
    // with function above, thus there is no need to check again.
    /*
    if (!this.delayWouldBeInTimelyManner(next)) {
      return false;
    }
    */
    if (this.interfaceName !== next.interfaceName) {
      // can't combine packets which get sent via different interfaces
      return false;
    }

    this.packet.initEncodingMode();
    next.packet.initEncodingMode();

    if (!next.packet.canBeCombinedWith(this.packet)) {
      // packets can't be combined
      return false;
    }

    next.packet.combineWith(this.packet);
    next.timeOfCreation = Math.min(this.timeOfCreation, next.timeOfCreation);

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.delayed = true;

    return true;
  }

  public combineWithUniqueResponseIfPossible(response: QueryResponse, interfaceName: string): boolean {
    if (this.interfaceName !== interfaceName) {
      // can't combine packets which get sent via different interfaces
      return false;
    }

    this.packet.initEncodingMode();
    response.asPacket().initEncodingMode();

    if (!this.packet.canBeCombinedWith(response.asPacket())) {
      return false; // packets can't be combined
    }

    this.packet.combineWith(response.asPacket());
    return true;
  }

}
