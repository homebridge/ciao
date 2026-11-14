import { QType, RType } from "./DNSPacket";
import { dnsTypeToString } from "./dns-string-utils";

describe(dnsTypeToString, () => {
  it.each<[RType | QType, string]>([
    [ RType.A, "A" ],
    [ RType.CNAME, "CNAME" ],
    [ RType.PTR, "PTR" ],
    [ RType.TXT, "TXT" ],
    [ RType.AAAA, "AAAA" ],
    [ RType.SRV, "SRV" ],
    [ RType.OPT, "OPT" ],
    [ RType.NSEC, "NSEC" ],
    [ QType.ANY, "ANY" ],
  ])("should name type %d %s", (type, name) => {
    expect(dnsTypeToString(type)).toBe(name);
  });

  it("should name a type ciao does not know by its number", () => {
    expect(dnsTypeToString(15 as RType)).toBe("UNSUPPORTED_15");
  });
});
