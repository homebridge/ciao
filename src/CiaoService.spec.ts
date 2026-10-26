import os from "os";
import { CiaoService, ServiceOptions } from "./CiaoService";
import { DNSLabelCoder } from "./coder/DNSLabelCoder";
import { RClass, RType } from "./coder/DNSPacket";
import { AAAARecord } from "./coder/records/AAAARecord";
import { NetworkInterface, NetworkManager } from "./NetworkManager";
import { dnsLowerCase } from "./util/dns-equal";

// The types the address NSEC of en0 lists, for a service whose records are built from an interface map holding en0 with the addresses given, or undefined
// when the service holds no NSEC there.
function addressNSECTypes(addresses: Partial<NetworkInterface>, options: Partial<ServiceOptions> = {}): RType[] | undefined {
  const en0: NetworkInterface = { name: "en0", loopback: false, mac: "00:00:5e:00:53:01", ...addresses };
  const networkManager = { getInterfaceMap: () => new Map([[ en0.name, en0 ]]) } as unknown as NetworkManager;
  const service = new CiaoService(networkManager, {
    name: "Test Service",
    type: "http",
    port: 4711,
    ...options,
  });
  service.rebuildServiceRecords();

  const record = service.addressNSECRecord("en0");
  if (!record) {
    return undefined;
  }

  const types: RType[] = [];
  for (const window of record.rrTypeWindows) {
    types.push(...window.rrtypes);
  }
  return types;
}

describe(CiaoService, () => {
  describe("addressNSECRecord", () => {
    it("should assert A and AAAA records", () => {
      expect(addressNSECTypes({ ipv4: "192.0.2.1", ipv6: "fe80::1" })).toStrictEqual([RType.A, RType.AAAA]);
    });

    it("should not assert AAAA records when IPv6 is disabled", () => {
      // RFC 6762 6.1.: the bitmap lists the types which do exist for the name. Listing AAAA
      // without having such a record leaves a querier waiting for an answer that never comes.
      expect(addressNSECTypes({ ipv4: "192.0.2.1", ipv6: "fe80::1" }, { disabledIpv6: true })).toStrictEqual([RType.A]);
    });

    // The bitmap is read from the records the service holds on the interface, so an interface carrying one address type lists that type alone, any of
    // the link-local, routable and unique local addresses standing for AAAA, and an interface carrying neither has no address NSEC.
    it.each<[string, Partial<NetworkInterface>, RType[] | undefined]>([
      ["an IPv4-only interface", { ipv4: "192.0.2.1" }, [RType.A]],
      ["an interface with only a link-local IPv6 address", { ipv6: "fe80::1" }, [RType.AAAA]],
      ["an interface with only a routable IPv6 address", { globallyRoutableIpv6: "2001:db8::1" }, [RType.AAAA]],
      ["an interface with only a unique local IPv6 address", { uniqueLocalIpv6: "fd00::1" }, [RType.AAAA]],
      ["an interface with no address", {}, undefined],
    ])("should list the address types %s carries", (_, addresses, expected) => {
      expect(addressNSECTypes(addresses)).toStrictEqual(expected);
    });
  });

  describe("sharesAddressRecordsWith (#20)", () => {
    beforeEach(() => {
      // an IP address restriction is resolved to the interface holding it, which must not depend on this machine
      jest.spyOn(NetworkManager, "resolveInterface").mockReturnValue("en1");
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function makeService(options: Partial<ServiceOptions> = {}): CiaoService {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      return new CiaoService(networkManager, { name: "Test Service", type: "http", port: 4711, ...options });
    }

    it("should share when neither service restricts its addresses", () => {
      expect(makeService().sharesAddressRecordsWith(makeService({ type: "ipp" }))).toBe(true);
    });

    it("should share when both restrict to the same addresses, in any order", () => {
      const a = makeService({ restrictedAddresses: ["en0", "192.168.1.2", "192.168.1.3"] });
      const b = makeService({ restrictedAddresses: ["192.168.1.3", "192.168.1.2", "en0"] });
      expect(a.sharesAddressRecordsWith(b)).toBe(true);
    });

    it("should not share when only one service disables IPv6", () => {
      expect(makeService().sharesAddressRecordsWith(makeService({ disabledIpv6: true }))).toBe(false);
    });

    it("should not share when only one service restricts its addresses", () => {
      expect(makeService().sharesAddressRecordsWith(makeService({ restrictedAddresses: ["en0"] }))).toBe(false);
    });

    it("should not share when the services are restricted to different addresses", () => {
      const a = makeService({ restrictedAddresses: ["192.168.1.2"] });
      const b = makeService({ restrictedAddresses: ["192.168.1.3"] });
      expect(a.sharesAddressRecordsWith(b)).toBe(false);
    });
  });

  describe("advertisesOnInterface", () => {
    // The MDNSServer names an interface's IPv6 socket "<name>/6" and asks with that name before it
    // probes, announces or answers there; restrictedAddresses is keyed by the interface's own name.
    function restrictedTo(name: string): CiaoService {
      const networkInterface: NetworkInterface = {
        name: "eth0",
        loopback: false,
        mac: "00:00:00:00:00:00",
        ipv4: "192.0.2.1",
        ip4Netmask: "255.255.255.0",
        ipv4Netaddress: "192.0.2.0",
        ipv6: "fe80::1",
        ipv6Netmask: "ffff:ffff:ffff:ffff::",
      };
      const networkManager = {
        getInterfaceMap: () => new Map([[networkInterface.name, networkInterface]]),
      } as unknown as NetworkManager;
      const service = new CiaoService(networkManager, {
        name: "Test Service",
        type: "http",
        port: 4711,
        restrictedAddresses: [name],
      });
      service.rebuildServiceRecords();
      return service;
    }

    it("should advertise on the IPv6 socket of an interface it is restricted to", () => {
      const service = restrictedTo("eth0");
      expect(service.advertisesOnInterface("eth0")).toBe(true);
      expect(service.advertisesOnInterface("eth0/6")).toBe(true);
      expect(service.advertisesOnInterface("eth0/6", true)).toBe(true);
    });

    it("should not advertise on the IPv6 socket of an interface it isn't restricted to", () => {
      const service = restrictedTo("eth1");
      expect(service.advertisesOnInterface("eth0/6", true)).toBe(false);
    });
  });

  describe("IPv6 address spelling", () => {
    // A routable address whose only zero hextet is a lone one, which RFC 5952 keeps as "0" and a shortener compressing it to "::" would spell another way.
    const routableAddress = "2001:db8:1234:0:abcd:ef01:2345:6789";
    let networkManager: NetworkManager | undefined;

    afterEach(() => {
      networkManager?.shutdown();
      networkManager = undefined;
      jest.restoreAllMocks();
    });

    // A NetworkManager restricted to eth0 by name, so no platform command runs, reading its interface map from an operating system that reports an IPv4
    // address and one IPv6 address on eth0, the IPv6 one in the spelling and scope given.
    async function managerReporting(address: string, scopeid: number): Promise<NetworkManager> {
      jest.spyOn(os, "networkInterfaces").mockReturnValue({
        eth0: [
          { address: "192.0.2.1", cidr: "192.0.2.1/24", family: "IPv4", internal: false, mac: "00:00:5e:00:53:01", netmask: "255.255.255.0" },
          { address: address, cidr: address + "/64", family: "IPv6", internal: false, mac: "00:00:5e:00:53:01", netmask: "ffff:ffff:ffff:ffff::", scopeid: scopeid },
        ],
        lo: [
          { address: "127.0.0.1", cidr: "127.0.0.1/8", family: "IPv4", internal: true, mac: "00:00:00:00:00:00", netmask: "255.0.0.0" },
        ],
      });

      networkManager = new NetworkManager({ interface: "eth0" });
      await networkManager.waitForInit();
      return networkManager;
    }

    // The address text of the AAAA record decoded from an address's 16 bytes, given as hex, as a record received from the network carries it.
    function receivedAddress(hex: string): string {
      const header = { name: "Test-Service.local.", type: RType.AAAA, class: RClass.IN, ttl: 120, flushFlag: true };
      return AAAARecord.decodeData(new DNSLabelCoder(), header, Buffer.from(hex, "hex"), 0).data.ipAddress;
    }

    // Each interface-map field's address is reported in Node's own spelling and in a lowercase spelling Node does not produce, which stands in for any
    // operating system spelling that differs from ciao's: in each, the service recognizes its own address coming back from the network.
    const fieldCases: ["ipv6" | "globallyRoutableIpv6" | "uniqueLocalIpv6", string, number, string, string][] = [
      ["ipv6", "fe80::1:2:3:4", 2, "fe800000000000000001000200030004", "fe80::1:2:3:4"],
      ["ipv6", "fe80:0:0:0:1:2:3:4", 2, "fe800000000000000001000200030004", "fe80::1:2:3:4"],
      ["globallyRoutableIpv6", routableAddress, 0, "20010db812340000abcdef0123456789", routableAddress],
      ["globallyRoutableIpv6", "2001:db8:1234::abcd:ef01:2345:6789", 0, "20010db812340000abcdef0123456789", routableAddress],
      ["uniqueLocalIpv6", "fd12:3456:789a:0:1:2:3:4", 0, "fd123456789a00000001000200030004", "fd12:3456:789a:0:1:2:3:4"],
      ["uniqueLocalIpv6", "fd12:3456:789a::1:2:3:4", 0, "fd123456789a00000001000200030004", "fd12:3456:789a:0:1:2:3:4"],
    ];

    it.each(fieldCases)("should own its %s address a received AAAA record carries when the operating system spells it %s",
      async (field, spelling, scopeid, hex, canonical) => {
        const manager = await managerReporting(spelling, scopeid);
        const service = new CiaoService(manager, { name: "Test Service", type: "http", port: 4711 });
        service.rebuildServiceRecords();

        expect(manager.getInterface("eth0")?.[field]).toBe(canonical);
        expect(receivedAddress(hex)).toBe(canonical);
        expect(service.hasAddress(receivedAddress(hex))).toBe(true);
      });

    it("should restrict to the interface holding an address given in another spelling", async () => {
      const service = new CiaoService(await managerReporting(routableAddress, 0), {
        name: "Test Service",
        type: "http",
        port: 4711,
        restrictedAddresses: ["2001:0DB8:1234:0:ABCD:EF01:2345:6789"],
      });
      service.rebuildServiceRecords();

      expect(service.advertisesOnInterface("eth0")).toBe(true);
      expect(service.aaaaRoutableRecord("eth0")?.ipAddress).toBe(routableAddress);
    });
  });

  describe("service names holding a dot or a backslash", () => {
    function serviceNamed(name: string, options: Partial<ServiceOptions> = {}): CiaoService {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      return new CiaoService(networkManager, { name: name, type: "hap", port: 4711, ...options });
    }

    // The name a buffer holding one name decodes to, and the raw labels it carries, read by their length bytes up to the root label.
    function encoded(name: string): { decoded: string, labels: string[] } {
      const coder = new DNSLabelCoder();
      const buffer = Buffer.alloc(coder.getNameLength(name));
      coder.initBuf(buffer);
      coder.encodeName(name, 0);

      const labels: string[] = [];
      for (let offset = 0; buffer[offset] !== 0; offset += 1 + buffer[offset]) {
        labels.push(buffer.toString("utf-8", offset + 1, offset + 1 + buffer[offset]));
      }

      const decoder = new DNSLabelCoder();
      decoder.initBuf(buffer);
      return { decoded: decoder.decodeName(0).data, labels: labels };
    }

    it("should escape the dot in its FQDN while the name and its change event stay raw", () => {
      const service = serviceNamed("Mr. Coffee");
      const names: string[] = [];
      service.on("name-change", name => names.push(name));

      expect(service.getFQDN()).toBe("Mr\\. Coffee._hap._tcp.local.");

      service.incrementName();
      service.informAboutNameUpdates();

      expect(names).toEqual(["Mr. Coffee (2)"]);
      expect(service.getFQDN()).toBe("Mr\\. Coffee (2)._hap._tcp.local.");
    });

    it.each([
      ["Mr. Coffee", "Mr--Coffee.local.", ["Mr--Coffee", "local"]],
      ["Foo\\Bar", "Foo\\\\Bar.local.", ["Foo\\Bar", "local"]],
      ["Coffee\\", "Coffee\\\\.local.", ["Coffee\\", "local"]],
      ["My Service", "My-Service.local.", ["My-Service", "local"]],
    ])("should derive one hostname label from %s, the hostname %s round tripping through the coder", (name, hostname, labels) => {
      const service = serviceNamed(name);

      expect(service.getHostname()).toBe(hostname);
      expect(encoded(hostname)).toEqual({ decoded: hostname, labels: labels });
    });

    it("should take an explicit hostname as a domain name", () => {
      expect(serviceNamed("Mr. Coffee", { hostname: "foo.bar" }).getHostname()).toBe("foo.bar.local.");
    });

    it("should answer to the lowercased name a packet carries for its dotted instance label", () => {
      const service = serviceNamed("Mr. Coffee");
      const buffer = Buffer.from([ 10, ...Buffer.from("Mr. Coffee"), 4, ...Buffer.from("_hap"), 4, ...Buffer.from("_tcp"), 5, ...Buffer.from("local"), 0 ]);
      const decoder = new DNSLabelCoder();
      decoder.initBuf(buffer);

      expect(service.getLowerCasedFQDN()).toBe(dnsLowerCase(decoder.decodeName(0).data));
    });

    it.each([
      ["an instance label over 63 octets, dotted into shorter pieces", "a".repeat(32) + "." + "b".repeat(32), {}, /takes 65 octets as an instance label/],
      ["a derived hostname label over 63 octets", "Living Room " + "x".repeat(52), {}, /takes 64 octets/],
      ["an FQDN over 255 octets in fewer than 255 characters", "Test", { domain: Array(4).fill("é".repeat(31)).join(".") }, /takes 268 octets on the wire/],
    ])("should reject %s with a sentence naming the octets", (_, name, options, message) => {
      expect(() => serviceNamed(name, options)).toThrow(message);
    });
  });
});
