import { DNSPacket } from "../coder/DNSPacket";
import { ARecord } from "../coder/records/ARecord";
import { QueuedResponse } from "./QueuedResponse";

describe(QueuedResponse, () => {
  it("should not fire after cancel", async () => {
    const packet = DNSPacket.createDNSResponsePacketsFromRRSet({
      answers: [new ARecord("test.local", "192.168.1.1", true)],
    });

    const response = new QueuedResponse(packet, "en0");
    response.calculateRandomDelay();

    const callback = jest.fn();
    response.scheduleResponse(callback);

    response.cancel();

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(callback).not.toHaveBeenCalled();
  });
});
