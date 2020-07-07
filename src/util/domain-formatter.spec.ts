import { ServiceType } from "../CiaoService";
import { Protocol } from "../index";
import {
  enlargeIPv6,
  formatHostname,
  formatReverseAddressPTRName,
  getNetAddress,
  ipAddressFromReversAddressName,
  parseFQDN,
  removeTLD,
  shortenIPv6,
  stringify,
} from "./domain-formatter";

describe("domain-formatter", () => {
  describe(parseFQDN, () => {

    it("should parse tcp ptr query domain", () => {
      const parsed = parseFQDN("_hap._tcp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.TCP,
        type: ServiceType.HAP,
      });
    });

    it("should parse udp ptr query domain", () => {
      const parsed = parseFQDN("_hap._udp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.UDP,
        type: ServiceType.HAP,
      });
    });


    it("should parse instance domain", () => {
      const parsed = parseFQDN("My Great Device._hap._tcp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.TCP,
        type: ServiceType.HAP,
        name: "My Great Device",
      });
    });

    it("should parse instance domain with dotted name", () => {
      const parsed = parseFQDN("My.Great.Device._hap._tcp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.TCP,
        type: ServiceType.HAP,
        name: "My.Great.Device",
      });
    });

    it("should parse service type enumeration query", () => {
      const parsed = parseFQDN("_services._dns-sd._udp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.UDP,
        type: ServiceType.DNS_SD,
        name: "services",
      });
    });


    it("should parse sub typed domain", () => {
      const parsed = parseFQDN("_printer._sub._http._tcp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.TCP,
        type: ServiceType.HTTP,
        subtype: ServiceType.PRINTER,
      });
    });

    it("should reject illegal protocol type", () => {
      expect(() => parseFQDN("_hap._asd.local")).toThrow();
    });

    it("should reject to short domain", () => {
      expect(() => parseFQDN(".local")).toThrow();
    });

  });

  describe(stringify, () => {
    it("should stringify basic domain with defaults", () => {
      expect(stringify({
        name: "My Device",
        type: ServiceType.HAP,
      })).toStrictEqual("My Device._hap._tcp.local.");
    });

    it("should stringify basic domain ", () => {
      expect(stringify({
        name: "My Device",
        type: ServiceType.AIRPLAY,
        protocol: Protocol.UDP,
        domain: "custom",
      })).toStrictEqual("My Device._airplay._udp.custom.");
    });

    it("should stringy sub typed ptr domain name" , () => {
      expect(stringify({
        type: ServiceType.HAP,
        subtype: ServiceType.AIRPLAY,
        protocol: Protocol.UDP,
        domain: "custom",
      })).toStrictEqual("_airplay._sub._hap._udp.custom.");
    });

    it("should stringify ptr domain name", () => {
      expect(stringify({
        type: ServiceType.HAP,
      })).toStrictEqual("_hap._tcp.local.");
    });
  });

  describe("hostname", () => {
    it("should format hostname", () => {
      expect(formatHostname("MYComputer")).toStrictEqual("MYComputer.local.");
    });

    it("should remove tld", () => {
      expect(removeTLD("test.local")).toBe("test");
      expect(removeTLD("test.local.")).toBe("test");
    });
  });

  describe(enlargeIPv6, () => {
    it("should enlarge ipv6", () => {
      expect(enlargeIPv6("ffff:ffff:ffff:ffff::")).toBe("ffff:ffff:ffff:ffff:0000:0000:0000:0000");
      expect(enlargeIPv6("fe80::72ee:50ff:fe63:d1a0")).toBe("fe80:0000:0000:0000:72ee:50ff:fe63:d1a0");
      expect(enlargeIPv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
      expect(enlargeIPv6("2001:db8::ff00:42:8329")).toBe("2001:0db8:0000:0000:0000:ff00:0042:8329");
    });
  });

  describe(shortenIPv6, () => {
    it("should shorten ipv6", () => {
      expect(shortenIPv6("ffff:ffff:ffff:ffff:0000:0000:0000:0000")).toBe("ffff:ffff:ffff:ffff::");
      expect(shortenIPv6("fe80:0000:0000:0000:72ee:50ff:fe63:d1a0")).toBe("fe80::72ee:50ff:fe63:d1a0");
      expect(shortenIPv6("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
      expect(shortenIPv6("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("2001:db8::ff00:42:8329");
    });

    it("should shorten the longest consecutive block of zeros (and only one)", () => {
      expect(shortenIPv6("ffff:0000:0000:ffff:0000:0000:0000:ffff")).toBe("ffff:0:0:ffff::ffff");
      expect(shortenIPv6("ffff:0000:0000:0000:ffff:0000:0000:ffff")).toBe("ffff::ffff:0:0:ffff");
    });

    it("should shorten the first if there are more than one with the same length", () => {
      expect(shortenIPv6("ffff:0000:0000:ffff:ffff:0000:0000:ffff")).toBe("ffff::ffff:ffff:0:0:ffff");
    });
  });

  describe(formatReverseAddressPTRName, () => {
    it("should format ipv4", () => {
      expect(formatReverseAddressPTRName("192.168.1.23")).toBe("23.1.168.192.in-addr.arpa");
    });

    it("should format ipv6", () => {
      // link-local
      expect(formatReverseAddressPTRName("fe80::72ee:50ff:fe63:d1a0")).toBe("0.A.1.D.3.6.E.F.F.F.0.5.E.E.2.7.0.0.0.0.0.0.0.0.0.0.0.0.0.8.E.F.ip6.arpa");
      // loopback
      expect(formatReverseAddressPTRName("::1")).toBe("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa");
      // routable
      expect(formatReverseAddressPTRName("2001:db8::ff00:42:8329")).toBe("9.2.3.8.2.4.0.0.0.0.F.F.0.0.0.0.0.0.0.0.0.0.0.0.8.B.D.0.1.0.0.2.ip6.arpa");
    });

    it("should catch illegal ip address format", () => {
      expect(() => formatReverseAddressPTRName("192.168.1")).toThrow(Error);
    });
  });

  describe(ipAddressFromReversAddressName, () => {
    it("should parse ipv4 query", () => {
      expect(ipAddressFromReversAddressName("23.1.168.192.in-addr.arpa")).toBe("192.168.1.23");
    });

    it("should parse ipv6 query", () => {
      expect(ipAddressFromReversAddressName("0.A.1.D.3.6.E.F.F.F.0.5.E.E.2.7.0.0.0.0.0.0.0.0.0.0.0.0.0.8.E.F.ip6.arpa")).toBe("fe80::72ee:50ff:fe63:d1a0");
      expect(ipAddressFromReversAddressName("1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa")).toBe("::1");
      expect(ipAddressFromReversAddressName("9.2.3.8.2.4.0.0.0.0.F.F.0.0.0.0.0.0.0.0.0.0.0.0.8.B.D.0.1.0.0.2.ip6.arpa")).toBe("2001:db8::ff00:42:8329");
    });

    it("should catch illegal ip address format", () => {
      expect(() => ipAddressFromReversAddressName("192.168.1")).toThrow(Error);
    });
  });

  describe(getNetAddress, () => {
    it("should calc netAddress for ipv4", () => {
      expect(getNetAddress("192.168.1.129", "255.255.255.0")).toBe("192.168.1.0");
      expect(getNetAddress("192.168.1.129", "0.0.0.255")).toBe("0.0.0.129");

      expect(getNetAddress("192.168.1.141", "255.255.255.0")).toBe("192.168.1.0");
      expect(getNetAddress("192.168.1.189", "255.255.255.0")).toBe("192.168.1.0");
    });

    it("should calc netAddress for ipv6", () => {
      expect(getNetAddress("fe80::803:bfee:be23:93a8", "ffff:ffff:ffff:ffff::")).toBe("fe80::");
      expect(getNetAddress("2003:f2:8725:ee00:1817:778e:aa58:4237", "ffff:ffff:ffff:ffff::")).toBe("2003:f2:8725:ee00::");
    });

    it("should catch illegal ip address format", () => {
      expect(() => getNetAddress("192.168.1", "255.255.0")).toThrow(Error);
    });
  });

});
