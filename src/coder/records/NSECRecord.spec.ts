import { RType } from "../DNSPacket";
import { runRecordEncodingTest } from "../test-utils";
import { NSECRecord } from "./NSECRecord";

describe(NSECRecord, () => {
  describe("rrtype bitmap sizing", () => {
    // Regression: ceil((type & 0xFF) / 8) underflowed by one whenever the
    // rrtype was an exact multiple of 8 — for example TXT (16) computed
    // bitMapSize = 2, but the bit for 16 lives in byte index 2, so encoding
    // wrote past the end of the bitmap buffer. The corrected formula is
    // (lowByte >> 3) + 1.
    it("sizes bitmap to fit a byte-aligned rrtype like TXT (16)", () => {
      const record = new NSECRecord("test.local.", "test.local.", [RType.TXT], 120);
      expect(record.rrTypeWindows).toHaveLength(1);
      expect(record.rrTypeWindows[0].bitMapSize).toBe(3);
    });

    it("still uses 1-byte bitmap for sub-byte rrtypes", () => {
      // Type 1 (A) lives in byte 0, so a 1-byte bitmap is sufficient.
      const record = new NSECRecord("test.local.", "test.local.", [RType.A], 120);
      expect(record.rrTypeWindows[0].bitMapSize).toBe(1);
    });

    it("survives full encode/decode roundtrip for byte-aligned rrtypes", () => {
      // Without the fix, encode would throw RangeError when writing to
      // byteNum=2 of a 2-byte allocated bitmap.
      runRecordEncodingTest(
        new NSECRecord("test.local.", "test.local.", [RType.TXT], 120),
      );
    });
  });
});
