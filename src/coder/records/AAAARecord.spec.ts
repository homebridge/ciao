import { DNSLabelCoder } from "../DNSLabelCoder";
import { RClass, RType } from "../DNSPacket";
import { AAAARecord } from "./AAAARecord";

// The record AAAARecord.decodeData builds from the 16 address bytes of an RDATA field, given as hex.
function decodedRecord(hex: string): AAAARecord {
  const header = { name: "host.local.", type: RType.AAAA, class: RClass.IN, ttl: 120, flushFlag: true };
  return AAAARecord.decodeData(new DNSLabelCoder(), header, Buffer.from(hex, "hex"), 0).data;
}

describe(AAAARecord, () => {
  describe("address text", () => {
    // A record holds its address in the RFC 5952 spelling whichever spelling it was built from, so it equals the record decoded from the same bytes.
    it.each([
      ["2001:0db8::1", "2001:db8::1", "20010db8000000000000000000000001"],
      ["2001:DB8::1", "2001:db8::1", "20010db8000000000000000000000001"],
      ["fe80:0:0:0:1:2:3:4", "fe80::1:2:3:4", "fe800000000000000001000200030004"],
      ["2001:0DB8:1234:0000:ABCD:EF01:2345:6789", "2001:db8:1234:0:abcd:ef01:2345:6789", "20010db812340000abcdef0123456789"],
    ])("should hold %s as %s and equal the record decoded from its bytes", (spelling, canonical, hex) => {
      const record = new AAAARecord("host.local.", spelling, true);
      const decoded = decodedRecord(hex);

      expect(record.ipAddress).toBe(canonical);
      expect(decoded.ipAddress).toBe(canonical);
      expect(record.dataEquals(decoded)).toBe(true);
    });
  });
});
