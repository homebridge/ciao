import {
  formatReverseAddressPTRName,
  formatHostname,
  parseFQDN,
  stringify,
  ipAddressFromReversAddressName,
} from "./domain-formatter";
import { Protocol } from "../index";
import { ServiceType } from "../CiaoService";

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
      })).toStrictEqual("My Device._hap._tcp.local");
    });

    it("should stringify basic domain ", () => {
      expect(stringify({
        name: "My Device",
        type: ServiceType.AIRPLAY,
        protocol: Protocol.UDP,
        domain: "custom",
      })).toStrictEqual("My Device._airplay._udp.custom");
    });

    it("should stringify ptr domain name", () => {
      expect(stringify({
        type: ServiceType.HAP,
      })).toStrictEqual("_hap._tcp.local");
    });
  });

  describe(formatHostname, () => {
    it("should format hostname", () => {
      expect(formatHostname("MYComputer")).toStrictEqual("MYComputer.local");
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
  });

});
