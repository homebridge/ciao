import {formatHostname, parseFQDN, stringify} from "./domain-formatter";
import {Protocol} from "../index";
import {ServiceType} from "../CiaoService";

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

    it("should reject weird domain", () => {
      expect(() => parseFQDN("weird.Name._hap._tcp.local")).toThrow();
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

});
