import { DNSLabelCoder } from "./DNSLabelCoder";

function bufferFromArrayMix(data: (string | number)[]): Buffer {
  const bufferArray: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const d0 = data[i];
    if (typeof d0 === "number") {
      bufferArray[i] = d0;
    } else {
      bufferArray[i] = Buffer.from(d0).readUInt8(0);
    }
  }

  return Buffer.from(bufferArray);
}

describe(DNSLabelCoder, () => {
  describe("name compression", () => {
    it("should encode name compression", () => {
      const coder = new DNSLabelCoder();
      const previous = DNSLabelCoder.DISABLE_COMPRESSION;
      DNSLabelCoder.DISABLE_COMPRESSION = false;

      let length = 0;

      length += coder.getNameLength("c.b.a."); // #7
      expect(length).toBe(7);
      length += coder.getNameLength("f.b.a."); // #4
      expect(length).toBe(11);
      length += coder.getNameLength("x.c.b.a."); // #4
      expect(length).toBe(15);
      length += coder.getNameLength("s.x.c.b.a."); // #4
      expect(length).toBe(19);
      length += coder.getNameLength("."); // #1
      expect(length).toBe(20);

      const buffer = Buffer.alloc(length);
      coder.initBuf(buffer);

      coder.encodeName("c.b.a.", 0);
      coder.encodeName("f.b.a.", 7);
      coder.encodeName("x.c.b.a.", 11);
      coder.encodeName("s.x.c.b.a.", 15);
      coder.encodeName(".", 19);

      const expected = bufferFromArrayMix([
        1, "c", 1, "b", 1, "a", 0,
        1, "f", 0xC0, 2,
        1, "x", 0xC0, 0,
        1, "s", 0xC0, 11,
        0,
      ]);
      expect(buffer.toString("hex")).toBe(expected.toString("hex"));

      DNSLabelCoder.DISABLE_COMPRESSION = previous;
    });

    // Regression: the >=256 branch of the "10" local-compression label type
    // used `localPointer -= -256`, which adds 256 instead of subtracting. The
    // draft format for these pointers is rare in the wild, but any decode that
    // reached this branch would resolve to the wrong place (or trip the
    // "must point to a prior location" assertion).
    it("decodes a local-compression pointer with the >=256 (RData-relative) form", () => {
      const buf = Buffer.alloc(40, 0xff);

      // Lay down a real name "X." at offset 6 (1 length byte, 'X', 0).
      buf[6] = 1;
      buf[7] = "X".charCodeAt(0);
      buf[8] = 0;

      // Local-compression pointer at offset 20:
      //   byte0 = 0x81 → high bits 10 (LOCAL_COMPRESSION_ONE_BYTE)
      //   byte1 = 0x00
      //   readUInt16BE(20) & 0x3FFF = 0x0100 = 256
      // After the fix this becomes 256 - 256 = 0, then offset by startOfRData (6),
      // landing at the "X." name. The bug would compute 256 + 256 = 512 + 6 = 518
      // (out of range, and beyond oldOffset, tripping the assertion).
      buf[20] = 0x81;
      buf[21] = 0x00;

      const coder = new DNSLabelCoder();
      coder.initBuf(buf);
      // startOfRData=6 means the >=256-form pointer (after subtracting 256)
      // resolves relative to offset 6.
      coder.initRRLocation(0, 6, 30);

      const decoded = coder.decodeName(20);
      expect(decoded.data).toBe("X.");
      expect(decoded.readBytes).toBe(2); // pointer is exactly 2 bytes
    });

    // Regression: computeLabelSuffixLength credited a shared top-level label
    // whenever the shorter name ran out of characters without one differing, so a
    // name that is a mid-label suffix of an earlier one ("Bridge._hap._tcp.local."
    // inside "My Bridge._hap._tcp.local.") was encoded as a bare pointer to it.
    // Two child bridges named that way put out one PTR instead of two and two SRV
    // records claiming the same name with different ports.
    it.each([
      [ "My Bridge._hap._tcp.local.", "Bridge._hap._tcp.local." ], // shares 3 labels, not 4
      [ "Ceiling Lights.local.", "Lights.local." ], // shares 1 label, not 2
      [ "Xlocal.", "local." ], // shares nothing at all
      [ "foo.local.", "local." ], // genuinely shares 1 label - must still compress
      [ "foo.local.", "bar.local." ], // genuinely shares 1 label
      [ "foo.local.", "foo.local." ], // identical - must still compress to a full pointer
    ])("round trips %s alongside %s", (first, second) => {
      const names = [ first, second ];

      const lengthCoder = new DNSLabelCoder();
      const length = names.reduce((total, name) => total + lengthCoder.getNameLength(name), 0);

      const buffer = Buffer.alloc(length);
      const encoder = new DNSLabelCoder();
      encoder.initBuf(buffer);

      const offsets: number[] = [];
      let offset = 0;
      for (const name of names) {
        offsets.push(offset);
        offset += encoder.encodeName(name, offset);
      }
      expect(offset).toBe(length); // the length pass and the encode pass must agree

      const decoder = new DNSLabelCoder();
      decoder.initBuf(buffer);
      expect(offsets.map(at => decoder.decodeName(at).data)).toEqual(names);
    });

    it("should decode name compression", () => {
      const coder = new DNSLabelCoder();

      // example from RFC 1035 4.1.4.

      const buf = Buffer.alloc(94, "X");
      const fIsiArpa = bufferFromArrayMix([
        1, "F", 3, "I", "S", "I", 4, "A", "R", "P", "A", 0,
      ]);
      const fooFIsiArpa = bufferFromArrayMix([
        3, "F", "O", "O", 0xC0, 20,
      ]);
      const arpa = bufferFromArrayMix([0xC0, 26]);
      const root = Buffer.alloc(1);

      fIsiArpa.copy(buf, 20);
      fooFIsiArpa.copy(buf, 40);
      arpa.copy(buf, 64);
      root.copy(buf, 92);

      coder.initBuf(buf);

      const decodedFIsiArpa = coder.decodeName(20);
      const decodedFooFIsiArpa = coder.decodeName(40);
      const decodedArpa = coder.decodeName(64);
      const decodedRoot = coder.decodeName(92);

      expect(decodedFIsiArpa.data).toBe("F.ISI.ARPA.");
      expect(decodedFIsiArpa.readBytes).toBe(12);
      expect(decodedFooFIsiArpa.data).toBe("FOO.F.ISI.ARPA.");
      expect(decodedFooFIsiArpa.readBytes).toBe(6);
      expect(decodedArpa.data).toBe("ARPA.");
      expect(decodedArpa.readBytes).toBe(2);
      expect(decodedRoot.data).toBe(".");
      expect(decodedRoot.readBytes).toBe(1);
    });
  });

  describe("name decoding limits", () => {
    // literal labels of the given lengths, ending with the root label
    function labels(...lengths: number[]): number[] {
      const bytes: number[] = [];
      for (const length of lengths) {
        bytes.push(length, ...Buffer.alloc(length, "a"));
      }
      bytes.push(0);
      return bytes;
    }

    function coderFor(bytes: number[]): DNSLabelCoder {
      const coder = new DNSLabelCoder();
      coder.initBuf(Buffer.from(bytes));
      return coder;
    }

    it("decodes a name of exactly 255 bytes", () => {
      const coder = coderFor(labels(63, 63, 63, 61)); // 64 * 3 + 62 + 1 = 255

      const decoded = coder.decodeName(0);
      expect(decoded.data.length).toBe(254); // 63 * 3 + 61 characters, 4 dots
      expect(decoded.readBytes).toBe(255);
    });

    it("rejects a name longer than 255 bytes", () => {
      const coder = coderFor(labels(63, 63, 63, 62)); // 256 bytes

      expect(() => coder.decodeName(0)).toThrow(/maximum length/);
    });

    it("rejects a name which only gets too long through a pointer", () => {
      const coder = coderFor([
        ...labels(63, 63, 63), // 193 bytes at 0
        0xC0, 0, // bare pointer to it at 193, fine
        60, ...Buffer.alloc(60, "b"), 0xC0, 0, // 61 + 193 = 254 bytes at 195, fine
        61, ...Buffer.alloc(61, "c"), 0xC0, 0, // 62 + 193 = 255 bytes at 258, fine
        62, ...Buffer.alloc(62, "d"), 0xC0, 0, // 63 + 193 = 256 bytes at 322, too long
      ]);

      expect(coder.decodeName(193).readBytes).toBe(2);
      expect(coder.decodeName(195).data).toBe("b".repeat(60) + "." + coder.decodeName(0).data);
      expect(coder.decodeName(258).readBytes).toBe(64);
      // the name at 0 was read and remembered through the pointers above, the limit must still hold
      expect(() => coder.decodeName(322)).toThrow(/maximum length/);
    });

    it("rejects too long chains of compression pointers", () => {
      // the root label at 0, followed by pointers each pointing to the one before
      const bytes = [ 0 ];
      for (let i = 0; i < 200; i++) {
        const target = i === 0? 0: 1 + (i - 1) * 2;
        bytes.push(0xC0 | (target >> 8), target & 0xFF);
      }
      const coder = coderFor(bytes);

      expect(coder.decodeName(1 + 127 * 2).data).toBe("."); // 128 pointers
      expect(() => coder.decodeName(1 + 128 * 2)).toThrow(/compression pointers/); // 129 pointers
      expect(() => coder.decodeName(1 + 199 * 2)).toThrow(/compression pointers/);
    });

    it("decodes the same name pointed to from different names", () => {
      const coder = coderFor([
        1, "a".charCodeAt(0), 5, ..."local".split("").map(char => char.charCodeAt(0)), 0, // "a.local." at 0
        1, "b".charCodeAt(0), 0xC0, 0, // "b.a.local." at 9
        1, "c".charCodeAt(0), 0xC0, 0, // "c.a.local." at 13
        1, "d".charCodeAt(0), 0xC0, 9, // "d.b.a.local." at 17
        0xC0, 2, // "local." at 21
      ]);

      expect([ 9, 13, 17, 21, 0 ].map(offset => coder.decodeName(offset).data))
        .toEqual([ "b.a.local.", "c.a.local.", "d.b.a.local.", "local.", "a.local." ]);
    });
  });
});
