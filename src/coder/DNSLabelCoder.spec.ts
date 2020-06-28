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
    it("should undo name compression", () => {
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
});
