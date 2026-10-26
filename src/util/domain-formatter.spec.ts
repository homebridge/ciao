import { SocketAddress } from "net";
import { ServiceType } from "../CiaoService";
import { DNSLabelCoder } from "../coder/DNSLabelCoder";
import { RClass, RType } from "../coder/DNSPacket";
import { AAAARecord } from "../coder/records/AAAARecord";
import { Protocol } from "../index";
import {
  canonicalizeIPv6,
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

// Node's own spelling (net.SocketAddress) follows RFC 5952, so it is the oracle for a lone zero at either end and in the middle, two equal runs, a shorter
// run or a lone zero ahead of a longer run, no zeros at all, the loopback and unspecified addresses, and hextets carrying leading zeros. Each is spelled
// with all eight hextets, so its 16 bytes are its hextets read in order.
const nodeSpelledAddresses = [
  "0:1:2:3:4:5:6:7", "1:0:2:3:4:5:6:7", "1:2:3:4:5:6:7:0", "2001:db8:1234:0:abcd:ef01:2345:6789",
  "ffff:0:0:ffff:ffff:0:0:ffff", "ffff:0:0:ffff:0:0:0:ffff", "ffff:0:ffff:0:0:ffff:ffff:ffff",
  "1:2:3:4:5:6:7:8", "0:0:0:0:0:0:0:1", "0:0:0:0:0:0:0:0", "2001:0db8:0000:0000:0000:ff00:0042:8329", "fe80:0:0:0:1:2:3:4",
];

/* The addresses around RFC 5952 section 5's mixed notation, each with its 16 bytes as hex: the IPv4-mapped and IPv4-compatible forms Node writes with a
 * dotted tail, in dotted, hex and zero-padded spellings, the addresses beside them Node keeps hex (the unspecified address, ::1, ::2, ::ffff and the RFC
 * 2765 form ::ffff:0:c000:201), and a zoned spelling, whose zone Node leaves out of the text. Then every address above, its bytes read from its hextets.
 */
const addressBytes: [string, string][] = [
  ["::ffff:192.0.2.1", "00000000000000000000ffffc0000201"],
  ["::ffff:c000:201", "00000000000000000000ffffc0000201"],
  ["0:0:0:0:0:ffff:0.1.2.3", "00000000000000000000ffff00010203"],
  ["::0.1.0.2", "00000000000000000000000000010002"],
  ["::", "00000000000000000000000000000000"],
  ["::1", "00000000000000000000000000000001"],
  ["::2", "00000000000000000000000000000002"],
  ["::ffff", "0000000000000000000000000000ffff"],
  ["::ffff:0:0", "00000000000000000000ffff00000000"],
  ["::ffff:0:c000:201", "0000000000000000ffff0000c0000201"],
  ["fe80::1%en0", "fe800000000000000000000000000001"],
  ...nodeSpelledAddresses.map((address): [string, string] => [ address, address.split(":").map(hextet => hextet.padStart(4, "0")).join("") ]),
];

// The address text of the AAAA record decoded from an address's 16 bytes, given as hex, as a record received from the network carries it.
function decodedAddress(hex: string): string {
  const header = { name: "host.local.", type: RType.AAAA, class: RClass.IN, ttl: 120, flushFlag: true };
  return AAAARecord.decodeData(new DNSLabelCoder(), header, Buffer.from(hex, "hex"), 0).data.ipAddress;
}

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
      const parsed = parseFQDN("My\\.Great\\.Device._hap._tcp.local");
      expect(parsed).toStrictEqual({
        domain: "local",
        protocol: Protocol.TCP,
        type: ServiceType.HAP,
        name: "My.Great.Device",
      });
    });

    it("should keep an escaped dot in a domain label", () => {
      const parsed = parseFQDN("Test._hap._tcp.foo\\.bar");
      expect(parsed).toStrictEqual({
        domain: "foo\\.bar",
        protocol: Protocol.TCP,
        type: ServiceType.HAP,
        name: "Test",
      });
    });

    it("should round-trip a domain holding an escaped dot through stringify", () => {
      expect(stringify(parseFQDN("Test._hap._tcp.foo\\.bar"))).toStrictEqual("Test._hap._tcp.foo\\.bar.");
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

    it("should escape a dot and a backslash in an instance name into one label", () => {
      expect(stringify({ name: "Mr. Coffee", type: ServiceType.HAP })).toStrictEqual("Mr\\. Coffee._hap._tcp.local.");
      expect(stringify({ name: "Foo\\Bar", type: ServiceType.HAP })).toStrictEqual("Foo\\\\Bar._hap._tcp.local.");
    });

    it("should escape a dot in a subtype into one label", () => {
      expect(stringify({ subtype: "v1.2", type: ServiceType.HTTP })).toStrictEqual("_v1\\.2._sub._http._tcp.local.");
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

    it("should properly enlarge ipv6 with ending double colon", () => {
      expect(enlargeIPv6("2001:db8:aaaa:a4c:305:ff:fe00::")).toBe("2001:0db8:aaaa:0a4c:0305:00ff:fe00:0000");
      expect(enlargeIPv6("2001:db8:aaaa:a4c:305:ff::")).toBe("2001:0db8:aaaa:0a4c:0305:00ff:0000:0000");
      expect(enlargeIPv6("2001:db8:aaaa:a4c:305::")).toBe("2001:0db8:aaaa:0a4c:0305:0000:0000:0000");
    });

    it("should properly enlarge ipv6 with starting double colon", () => {
      expect(enlargeIPv6("::db8:aaaa:a4c:305:ff:fe00:0")).toBe("0000:0db8:aaaa:0a4c:0305:00ff:fe00:0000");
      expect(enlargeIPv6("::aaaa:a4c:305:ff:fe00:0")).toBe("0000:0000:aaaa:0a4c:0305:00ff:fe00:0000");
      expect(enlargeIPv6("::a4c:305:ff:fe00:0")).toBe("0000:0000:0000:0a4c:0305:00ff:fe00:0000");
    });

    it("should enlarged RFC 3513 examples", () => {
      expect(enlargeIPv6("1080::8:800:200c:417a")).toBe("1080:0000:0000:0000:0008:0800:200c:417a");
      expect(enlargeIPv6("ff01::101")).toBe("ff01:0000:0000:0000:0000:0000:0000:0101");
      expect(enlargeIPv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
      expect(enlargeIPv6("::")).toBe("0000:0000:0000:0000:0000:0000:0000:0000");
    });
  });

  describe(shortenIPv6, () => {
    it("should shorten ipv6", () => {
      expect(shortenIPv6("ffff:ffff:ffff:ffff:0000:0000:0000:0000")).toBe("ffff:ffff:ffff:ffff::");
      expect(shortenIPv6("fe80:0000:0000:0000:72ee:50ff:fe63:d1a0")).toBe("fe80::72ee:50ff:fe63:d1a0");
      expect(shortenIPv6("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
      expect(shortenIPv6("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe("2001:db8::ff00:42:8329");
      expect(shortenIPv6("2001:0db8:0:73c8:0305:00ff:fe00:0aaa")).toBe("2001:db8:0:73c8:305:ff:fe00:aaa");
      expect(shortenIPv6("2001:0db8:aaaa:0a4c:0305:00ff:fe00:0000")).toBe("2001:db8:aaaa:a4c:305:ff:fe00:0");
    });

    it.each(nodeSpelledAddresses)("should shorten %s the way Node spells it", address => {
      expect(shortenIPv6(address)).toBe(new SocketAddress({ address: address, family: "ipv6" }).address);
    });

    it("should shorten the longest consecutive block of zeros (and only one)", () => {
      expect(shortenIPv6("ffff:0000:0000:ffff:0000:0000:0000:ffff")).toBe("ffff:0:0:ffff::ffff");
      expect(shortenIPv6("ffff:0000:0000:0000:ffff:0000:0000:ffff")).toBe("ffff::ffff:0:0:ffff");
    });

    it("should shorten the first if there are more than one with the same length", () => {
      expect(shortenIPv6("ffff:0000:0000:ffff:ffff:0000:0000:ffff")).toBe("ffff::ffff:ffff:0:0:ffff");
    });

    it("should shorten RFC 3513 examples", () => {
      expect(shortenIPv6("1080:0:0:0:8:800:200c:417a")).toBe("1080::8:800:200c:417a");
      expect(shortenIPv6("ff01:0:0:0:0:0:0:101")).toBe("ff01::101");
      expect(shortenIPv6("0:0:0:0:0:0:0:1")).toBe("::1");
      expect(shortenIPv6("0:0:0:0:0:0:0:0")).toBe("::");
    });
  });

  describe(canonicalizeIPv6, () => {
    it("should spell any form of an address the way Node does", () => {
      expect(canonicalizeIPv6("2001:0DB8:1234:0000:ABCD:EF01:2345:6789")).toBe("2001:db8:1234:0:abcd:ef01:2345:6789");
      expect(canonicalizeIPv6("2001:db8:1234::abcd:ef01:2345:6789")).toBe("2001:db8:1234:0:abcd:ef01:2345:6789");
      expect(canonicalizeIPv6("FE80:0:0:0:0:0:0:1")).toBe(new SocketAddress({ address: "FE80:0:0:0:0:0:0:1", family: "ipv6" }).address);
      expect(canonicalizeIPv6("::")).toBe("::");
    });

    // The canonicalizer and the decoder each write the text Node writes for the same address, and a record built from the spelling encodes its bytes.
    it.each(addressBytes)("should spell %s, and the record decoded from its bytes, the way Node does, encoding the same bytes", (spelling, hex) => {
      const oracle = new SocketAddress({ address: spelling, family: "ipv6" }).address;

      expect(canonicalizeIPv6(spelling)).toBe(oracle);
      expect(decodedAddress(hex)).toBe(oracle);
      expect(new AAAARecord("host.local.", spelling).getRawData().toString("hex")).toBe(hex);
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

    // Every canonical text names a reverse address, read from the address's bytes: an IPv4-mapped address the in-addr.arpa name of the IPv4 address it
    // carries, and any other the ip6.arpa name of its 32 nibbles.
    it.each(addressBytes)("should name the reverse address of the canonical text of %s", (spelling, hex) => {
      const bytes = Buffer.from(hex, "hex");
      const expected = hex.startsWith("00000000000000000000ffff")
        ? [...bytes.subarray(12)].reverse().join(".") + ".in-addr.arpa"
        : hex.toUpperCase().split("").reverse().join(".") + ".ip6.arpa";

      expect(formatReverseAddressPTRName(canonicalizeIPv6(spelling))).toBe(expected);
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
      expect(getNetAddress("2001:db8:8725:ee00:1817:778e:aa58:4237", "ffff:ffff:ffff:ffff::")).toBe("2001:db8:8725:ee00::");
    });

    it("should catch illegal ip address format", () => {
      expect(() => getNetAddress("192.168.1", "255.255.0")).toThrow(Error);
    });
  });

});
