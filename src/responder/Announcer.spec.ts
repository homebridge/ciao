import { Announcer } from "./Announcer";
import { DNSPacket } from "../coder/DNSPacket";
import { AAAARecord } from "../coder/records/AAAARecord";
import { InterfaceNotFoundError } from "../util/errors";

describe(Announcer, () => {
  describe("sendResponseAddingAddressRecords - sync throw handling", () => {
    let packetSpy: jest.SpyInstance;

    beforeEach(() => {
      // The function builds a DNSPacket via createDNSResponsePacketsFromRRSet
      // which validates record shapes. We don't care about the packet content
      // here — server.send is the unit under test — so stub it out.
      packetSpy = jest
        .spyOn(DNSPacket, "createDNSResponsePacketsFromRRSet")
        .mockReturnValue({} as DNSPacket);
    });

    afterEach(() => {
      packetSpy.mockRestore();
    });
    // Regression: MDNSServer.send throws InterfaceNotFoundError synchronously
    // when the socket for the requested interface has been torn down (network
    // change race). Previously that throw escaped the Promise.race wrapper,
    // propagated through sendAnnouncement (invoked via setTimeout) and
    // surfaced as an uncaughtException — crashing the host process.
    it("converts a synchronous send throw into a rejected SendResult", async () => {
      const thrownError = new InterfaceNotFoundError("socket gone");

      const server = {
        getBoundInterfaceNames: () => ["eth0"],
        send: jest.fn(() => {
          throw thrownError;
        }),
      };

      // Minimal nsec stand-ins — the function only reads/writes .ttl on these
      // when goodbye=true, so plain objects are fine for goodbye=false.
      const nsec = { ttl: 120 };
      const serviceNsec = { ttl: 120 };

      const service = {
        advertisesOnInterface: () => true,
        aRecord: () => undefined,
        aaaaRecord: () => undefined,
        aaaaRoutableRecord: () => undefined,
        aaaaUniqueLocalRecord: () => undefined,
        addressNSECRecord: () => nsec,
        serviceNSECRecord: () => serviceNsec,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await (Announcer as any).sendResponseAddingAddressRecords(
        server, service, [], false,
      );

      expect(server.send).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        status: "rejected",
        interface: "eth0",
        reason: thrownError,
      });
    });

    it("does not let the throw escape to the caller", () => {
      // The race-wrapping in the fix means the returned promise resolves
      // (with a rejected SendResult) rather than rejecting. A regression
      // would surface here as a synchronous throw escaping the call.
      const server = {
        getBoundInterfaceNames: () => ["eth0"],
        send: () => {
          throw new InterfaceNotFoundError("socket gone");
        },
      };
      const nsec = { ttl: 120 };
      const service = {
        advertisesOnInterface: () => true,
        aRecord: () => undefined,
        aaaaRecord: () => undefined,
        aaaaRoutableRecord: () => undefined,
        aaaaUniqueLocalRecord: () => undefined,
        addressNSECRecord: () => nsec,
        serviceNSECRecord: () => nsec,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (Announcer as any).sendResponseAddingAddressRecords(
        server, service, [], false,
      )).not.toThrow();
    });
  });

  describe("goodbye keeping the address records (#20)", () => {
    function sentRecords(keepAddressRecords: boolean) {
      const packetSpy = jest.spyOn(DNSPacket, "createDNSResponsePacketsFromRRSet").mockReturnValue({} as DNSPacket);
      const server = {
        getBoundInterfaceNames: () => ["eth0"],
        send: jest.fn(() => Promise.resolve({ status: "fulfilled", interface: "eth0" })),
      };
      const aRecord = { ttl: 120 };
      const nsec = { ttl: 120 };
      const serviceNsec = { ttl: 120 };
      const service = {
        advertisesOnInterface: () => true,
        aRecord: () => aRecord,
        aaaaRecord: () => undefined,
        aaaaRoutableRecord: () => undefined,
        aaaaUniqueLocalRecord: () => undefined,
        addressNSECRecord: () => nsec,
        serviceNSECRecord: () => serviceNsec,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (Announcer as any).sendResponseAddingAddressRecords(server, service, [], true, keepAddressRecords);
      const rrSet = packetSpy.mock.calls[0][0];
      packetSpy.mockRestore();
      return { rrSet, aRecord, nsec, serviceNsec };
    }

    it("withdraws the address records when no other service uses the hostname", () => {
      const { rrSet, aRecord, nsec } = sentRecords(false);
      expect(rrSet.answers).toContain(aRecord);
      expect(rrSet.additionals).toContain(nsec);
      expect(aRecord.ttl).toBe(0);
    });

    it("leaves the address records alone when another service still uses the hostname", () => {
      const { rrSet, aRecord, nsec, serviceNsec } = sentRecords(true);
      expect(rrSet.answers).not.toContain(aRecord);
      expect(rrSet.additionals).not.toContain(nsec);
      expect(rrSet.additionals).toContain(serviceNsec);
    });
  });

  describe("sendResponseAddingAddressRecords - IPv6 socket", () => {
    // The bound interface names include each interface's IPv6 socket, "<name>/6", while the
    // service's address records are keyed by the interface's own name.
    it("adds the interface's address records to an announcement on its IPv6 socket", async () => {
      const packetSpy = jest
        .spyOn(DNSPacket, "createDNSResponsePacketsFromRRSet")
        .mockReturnValue({} as DNSPacket);
      const aaaaRecord = new AAAARecord("host.local.", "fe80::1");
      const server = {
        getBoundInterfaceNames: () => ["eth0/6"],
        send: jest.fn(() => Promise.resolve({ status: "fulfilled", interface: "eth0/6" })),
      };
      const nsec = { ttl: 120 };
      const service = {
        advertisesOnInterface: () => true,
        aRecord: () => undefined,
        aaaaRecord: (name: string) => name === "eth0" ? aaaaRecord : undefined,
        aaaaRoutableRecord: () => undefined,
        aaaaUniqueLocalRecord: () => undefined,
        addressNSECRecord: () => nsec,
        serviceNSECRecord: () => nsec,
      };

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (Announcer as any).sendResponseAddingAddressRecords(server, service, [], false);

        expect(packetSpy).toHaveBeenCalledTimes(1);
        expect(packetSpy.mock.calls[0][0].answers).toContain(aaaaRecord);
      } finally {
        packetSpy.mockRestore();
      }
    });
  });
});
