import os from "os";
import { CiaoService, ServiceOptions } from "./CiaoService";
import { DNSLabelCoder } from "./coder/DNSLabelCoder";
import { RClass, RType } from "./coder/DNSPacket";
import { AAAARecord } from "./coder/records/AAAARecord";
import { NetworkInterface, NetworkManager } from "./NetworkManager";
import { dnsLowerCase } from "./util/dns-equal";
import { escapeLabel, splitLabels, wireLength } from "./util/dns-labels";

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

    /* A space becomes a dash in the hostname's own labels alone, and the domain is matched label by label, so a domain holding a space stays as the FQDN
     * spells it, an escaped dot in an own label is no separator, and a hostname carrying the domain in another spelling takes the domain's own.
     */
    it.each<[string, string, Partial<ServiceOptions>, string, string[]]>([
      ["an explicit hostname carrying a domain that holds a space", "Test", { domain: "my domain", hostname: "my host.my domain" }, "my-host.my domain.",
        [ "my-host", "my domain" ]],
      ["a hostname derived under a domain that holds a space", "My Service", { domain: "my domain" }, "My-Service.my domain.", [ "My-Service", "my domain" ]],
      ["an explicit hostname of one label whose text ends with an escaped dot and the domain", "Test", { hostname: "foo\\.local" }, "foo\\.local.local.",
        [ "foo.local", "local" ]],
      ["an explicit hostname carrying the domain after an own label ending in an escaped dot", "Test", { hostname: "a\\..local" }, "a\\..local.",
        [ "a.", "local" ]],
      ["an explicit hostname carrying the domain in another spelling", "Test", { domain: "my\\x", hostname: "foo.my\\x" }, "foo.myx.", [ "foo", "myx" ]],
      ["an explicit hostname ending in a lone backslash, which quotes nothing", "Test", { hostname: "foo\\" }, "foo.local.", [ "foo", "local" ]],
      ["an explicit hostname whose own label ends in an escaped dot and a lone backslash", "Test", { hostname: "a\\.\\" }, "a\\..local.", [ "a.", "local" ]],
      ["an explicit hostname that is the domain alone", "Test", { hostname: "local" }, "local.local.", [ "local", "local" ]],
      ["an explicit hostname whose last label alone is the domain's last", "Test", { domain: "my.domain", hostname: "a.foo.domain" }, "a.foo.domain.my.domain.",
        [ "a", "foo", "domain", "my", "domain" ]],
    ])("should form the hostname by label for %s, round tripping it through the coder", (_, name, options, hostname, labels) => {
      expect(serviceNamed(name, options).getHostname()).toBe(hostname);
      expect(encoded(hostname)).toEqual({ decoded: hostname, labels: labels });
    });

    // A backslash before a character other than a dot or a backslash quotes nothing, so the label carries the character alone, as the decoder spells it.
    it("should hold an explicit hostname in the spelling the label coder decodes it to", () => {
      const hostname = serviceNamed("Test", { hostname: "foo\\bar.b\\.c" }).getHostname();

      expect(hostname).toBe("foobar.b\\.c.local.");
      expect(encoded(hostname)).toEqual({ decoded: hostname, labels: [ "foobar", "b.c", "local" ] });
    });

    // The domain is held in the spelling the label coder decodes, so a backslash before a letter is dropped as the wire drops it, and every name built
    // from the domain decodes from its own encoding unchanged.
    it.each([
      ["a backslash before a letter", "my\\x", [ "Test._hap._tcp.myx.", "_hap._tcp.myx.", "Test.myx." ]],
      ["an escaped dot ending its last label", "foo\\.", [ "Test._hap._tcp.foo\\..", "_hap._tcp.foo\\..", "Test.foo\\.." ]],
    ])("should spell the FQDN, the type PTR and the hostname under a domain holding %s the way the label coder decodes them", (_, domain, expected) => {
      const service = serviceNamed("Test", { domain: domain });
      const names = [ service.getFQDN(), service.getTypePTR(), service.getHostname() ];

      expect(names).toEqual(expected);
      expect(names.map(name => encoded(name).decoded)).toEqual(names);
    });

    // A domain written absolute ends with the root label every name built from it appends anyway, so it gives the names its relative form gives.
    it.each([
      ["local.", "local"],
      ["my.domain.", "my.domain"],
    ])("should give the absolute domain %s the FQDN, the type PTR and the hostname of the domain %s", (absolute, relative) => {
      const names = (service: CiaoService): string[] => [ service.getFQDN(), service.getTypePTR(), service.getHostname() ];

      expect(names(serviceNamed("Test", { domain: absolute }))).toEqual(names(serviceNamed("Test", { domain: relative })));
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
      ["a 64-octet name, whose derived hostname label the instance check bounds too", "Living Room " + "x".repeat(52), {}, /takes 64 octets/],
      ["an FQDN over 255 octets in fewer than 255 characters", "Test", { domain: Array(4).fill("é".repeat(31)).join(".") }, /takes 268 octets on the wire/],
      ["a hostname label the name's number grows past 63 octets", "Test (2)", { hostname: "h".repeat(62) }, /The hostname '.*' holds a label of 66 octets/],
      ["a hostname label of 32 two-byte characters", "Test", { hostname: "é".repeat(32) }, /The hostname '.*' holds a label of 64 octets/],
      ["a hostname over 255 octets whose labels each fit", "Test", { hostname: [ ...Array(3).fill("h".repeat(63)), "h".repeat(56) ].join(".") },
        /The hostname '.*' takes 256 octets on the wire/],
      ["a hostname with an empty label", "Test", { hostname: "a..b" }, /The hostname 'a\.\.b\.local\.' holds a label of 0 octets/],
      ["a domain with an empty label ahead of the root", "Test", { domain: "local.." }, /The hostname 'Test\.local\.\.\.' holds a label of 0 octets/],
      ["a domain of a dot alone, one empty label", "Test", { domain: "." }, /The hostname 'Test\.\.\.' holds a label of 0 octets/],
      ["a domain with an empty label", "Test", { domain: "a..b" }, /The hostname 'Test\.a\.\.b\.' holds a label of 0 octets/],
      ["a domain label over 63 octets", "Test", { domain: "d".repeat(64) }, /The hostname '.*' holds a label of 64 octets/],
    ])("should reject %s with a sentence naming the octets", (_, name, options, message) => {
      expect(() => serviceNamed(name, options)).toThrow(message);
    });

    // A label is measured in octets on the wire, so an escape counts nothing, and a label of 63 octets, the most a DNS label may hold, constructs.
    it.each([
      ["a hostname label of 63 octets", "h".repeat(63)],
      ["a hostname label of 61 octets written in 91 characters", "a\\.".repeat(30) + "a"],
    ])("should construct %s", (_, hostname) => {
      expect(serviceNamed("Test", { hostname: hostname }).getHostname()).toBe(hostname + ".local.");
    });
  });

  /* A conflict rename, as the Prober asks for it, numbers the name and the hostname's last own label, and cuts either one first when the number would carry
   * it past the octets its DNS label or its DNS name may take (RFC 1035 2.3.4).
   */
  describe("a conflict rename", () => {
    // A service renamed once, with the name and hostname its change events report.
    function renamed(name: string, options: Partial<ServiceOptions> = {}): { hostname: string; name: string; service: CiaoService } {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      const service = new CiaoService(networkManager, { name: name, type: "hap", port: 4711, ...options });
      const reported = { hostname: "", name: "" };

      service.on("name-change", changed => {
        reported.name = changed;
      });
      service.on("hostname-change", changed => {
        reported.hostname = changed;
      });
      service.incrementName();
      service.informAboutNameUpdates();

      return { ...reported, service };
    }

    // Each name's octets, and the raw label of the hostname derived from it, are cut to leave room for the number within 63 octets, on a grapheme cluster,
    // so no character a reader sees is split.
    it.each([
      ["a 62-octet name", "a".repeat(62), "a".repeat(59) + " (2)", "a".repeat(59) + "-(2)"],
      ["a name ending in a two-byte character", "a".repeat(58) + "éé", "a".repeat(58) + " (2)", "a".repeat(58) + "-(2)"],
      ["a name ending in a four-byte character", "a".repeat(56) + "😀", "a".repeat(56) + " (2)", "a".repeat(56) + "-(2)"],
      ["a 62-octet dotted name", "a.".repeat(31), "a.".repeat(31).slice(0, 59) + " (2)", "a-".repeat(31).slice(0, 59) + "-(2)"],
      ["a name with a backslash at the cut", "a".repeat(58) + "\\bbb", "a".repeat(58) + "\\ (2)", "a".repeat(58) + "\\-(2)"],
      ["a name ending in a flag of two regional indicators", "a".repeat(55) + "\u{1F1E9}\u{1F1EA}", "a".repeat(55) + " (2)", "a".repeat(55) + "-(2)"],
      ["a name ending in a letter with a combining accent", "a".repeat(58) + "e\u0301x", "a".repeat(58) + " (2)", "a".repeat(58) + "-(2)"],
    ])("should shorten %s and its hostname label to fit the number in 63 octets", (_, name, expectedName, expectedLabel) => {
      const result = renamed(name);
      const labels = splitLabels(result.service.getHostname());

      expect(result.name).toBe(expectedName);
      expect(Buffer.byteLength(result.name)).toBeLessThanOrEqual(63);
      expect(labels).toEqual([ expectedLabel, "local", "" ]);
      expect(Buffer.byteLength(labels[0])).toBeLessThanOrEqual(63);
      expect(result.hostname).toBe(escapeLabel(expectedLabel));
      expect(result.service.getFQDN()).toBe(escapeLabel(expectedName) + "._hap._tcp.local.");
    });

    // A runtime without Intl.Segmenter cuts on a code point, which keeps a surrogate pair whole but can split a flag into its regional indicators.
    it("should cut on a code point where the runtime has no Intl.Segmenter", () => {
      const intl = Intl as unknown as { Segmenter?: typeof Intl.Segmenter };
      const segmenter = intl.Segmenter;

      intl.Segmenter = undefined;

      try {
        const result = renamed("a".repeat(55) + "\u{1F1E9}\u{1F1EA}");

        expect(result.name).toBe("a".repeat(55) + "\u{1F1E9} (2)");
        expect(result.hostname).toBe("a".repeat(55) + "\u{1F1E9}-(2)");
      } finally {
        intl.Segmenter = segmenter;
      }
    });

    // A runtime with no Intl global at all, such as a Node built without Intl, cuts on a code point too, so the guard reads the global before its Segmenter.
    it("should cut on a code point where the runtime has no Intl global", () => {
      const runtime = globalThis as { Intl?: unknown };
      const intl = runtime.Intl;

      delete runtime.Intl;

      try {
        expect(renamed("a".repeat(55) + "\u{1F1E9}\u{1F1EA}").service.getFQDN()).toBe("a".repeat(55) + "\u{1F1E9} (2)._hap._tcp.local.");
      } finally {
        runtime.Intl = intl;
      }
    });

    it("should number the last label of an explicit hostname", () => {
      const result = renamed("Test", { hostname: "host.sub" });

      expect(result.service.getHostname()).toBe("host.sub-(2).local.");
      expect(result.hostname).toBe("host.sub-(2)");
    });

    it("should number an explicit hostname whose own label ends in an escaped dot", () => {
      expect(renamed("Test", { hostname: "a\\.\\" }).service.getHostname()).toBe("a\\.-(2).local.");
    });

    // The hostname's other labels and its domain take 196 octets on the wire, so the 255 of the hostname bounds its last own label to 58, fewer than 63.
    it("should shorten an explicit hostname's last label to the octets its other labels and its domain leave the hostname", () => {
      const result = renamed("Test", { hostname: [ ...Array(3).fill("h".repeat(60)), "h".repeat(5), "x".repeat(56) ].join(".") });

      expect(splitLabels(result.service.getHostname())).toEqual([ ...Array(3).fill("h".repeat(60)), "h".repeat(5), "x".repeat(54) + "-(2)", "local", "" ]);
      expect(wireLength(splitLabels(result.service.getHostname()))).toBe(255);
    });

    it("should number an explicit hostname's own label under a domain holding a backslash, cutting the domain off whole", () => {
      const result = renamed("Test", { domain: "my\\x", hostname: "foo" });

      expect(result.service.getHostname()).toBe("foo-(2).myx.");
      expect(result.hostname).toBe("foo-(2)");
    });

    it("should number the hostname's own label under a multi-label domain and report the hostname without the domain", () => {
      const result = renamed("Foo", { domain: "my.domain" });

      expect(result.service.getHostname()).toBe("Foo-(2).my.domain.");
      expect(result.hostname).toBe("Foo-(2)");
      expect(result.service.getFQDN()).toBe("Foo (2)._hap._tcp.my.domain.");
    });

    // A domain of three 60-octet labels leaves an instance label 60 octets within the 255 of the FQDN, fewer than the 63 a label may hold.
    it("should shorten the name to the octets a long custom domain leaves the FQDN", () => {
      const result = renamed("a".repeat(58), { domain: Array(3).fill("d".repeat(60)).join(".") });

      expect(result.name).toBe("a".repeat(56) + " (2)");
      expect(wireLength(splitLabels(result.service.getFQDN()))).toBe(255);
      expect(splitLabels(result.service.getHostname())[0]).toBe("a".repeat(58) + "-(2)");
    });

    it("should refuse a rename no prefix of the name fits, leaving the service unchanged", () => {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      const service = new CiaoService(networkManager, { domain: Array(4).fill("d".repeat(59)).join("."), name: "a", port: 4711, type: "http" });
      const before = [ service.getFQDN(), service.getHostname() ];

      expect(() => service.incrementName()).toThrow("The service name 'a' has no prefix that fits with the number ' (2)'");
      expect([ service.getFQDN(), service.getHostname() ]).toEqual(before);
    });

    it("should refuse at construction a persisted name the hostname's number carries past 63 octets, emitting no name-change", () => {
      const emit = jest.spyOn(CiaoService.prototype, "emit");
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;

      try {
        expect(() => new CiaoService(networkManager, { hostname: "h-(10)", name: "x".repeat(59) + " (9)", port: 4711, type: "hap" }))
          .toThrow(/takes 64 octets as an instance label/);
        expect(emit.mock.calls.map(call => String(call[0]))).not.toContain("name-change");
      } finally {
        emit.mockRestore();
      }
    });
  });
});
