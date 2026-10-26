import { AddressInfo } from "net";
import { DNSLabelCoder } from "./DNSLabelCoder";
import { OptionalDecodedData, RType } from "./DNSPacket";
import { AAAARecord } from "./records/AAAARecord";
import { ARecord } from "./records/ARecord";
import { CNAMERecord } from "./records/CNAMERecord";
import { NSECRecord } from "./records/NSECRecord";
import { OPTOption, OPTRecord } from "./records/OPTRecord";
import { PTRRecord } from "./records/PTRRecord";
import { SRVRecord } from "./records/SRVRecord";
import { TXTRecord } from "./records/TXTRecord";
import { ResourceRecord } from "./ResourceRecord";
import { runRecordEncodingTest } from "./test-utils";

// The bytes one record encodes to on its own, as hex.
function encodedHex(record: ResourceRecord): string {
  const coder = new DNSLabelCoder();
  const buffer = Buffer.alloc(record.getEncodingLength(coder));

  coder.initBuf(buffer);
  record.encode(coder, buffer, 0);
  return buffer.toString("hex");
}

describe(ResourceRecord, () => {
  it("should encode AAAA", () => {
    runRecordEncodingTest(new AAAARecord("test.local.", "::1"));
    runRecordEncodingTest(new AAAARecord("sub.test.local.", "fe80::14b0:44f7:b2ae:18e5"));
  });

  it("should encode A", () => {
    runRecordEncodingTest(new ARecord("test.local.", "192.168.178.1"));
    runRecordEncodingTest(new ARecord("sub.test.local.", "192.168.0.1"));
  });

  it("should encode IPv4-mapped IPv6 addresses in AAAA records", () => {
    runRecordEncodingTest(new AAAARecord("v4mapped.local.", "::ffff:192.168.178.1"));
    runRecordEncodingTest(new AAAARecord("sub.v4mapped.local.", "::ffff:192.168.0.1"));
  });

  it("should encode CNAME", () => {
    runRecordEncodingTest(new CNAMERecord("test.local.", "test2.local."));
    runRecordEncodingTest(new CNAMERecord("sub.test.local.", "test2.local."));
  });

  it("should encode NSEC", () => {
    runRecordEncodingTest(new NSECRecord("test.local.", "test.local.", [RType.TXT, RType.SRV, RType.A], 120));
    runRecordEncodingTest(new NSECRecord("sub.test.local.", "sub.test.local.", [RType.CNAME, RType.AAAA], 120));
  });

  it("should encode OPT", () => {
    const options: OPTOption[] = [{ code: 1337, data: Buffer.from("hello world")}, { code: 123, data: Buffer.from("456")}];

    runRecordEncodingTest(new OPTRecord(1472));
    runRecordEncodingTest(new OPTRecord(1472, options));
    runRecordEncodingTest(new OPTRecord(1472, [], 13, { dnsSecOK: true }));
    runRecordEncodingTest(new OPTRecord(1472, options, 13, { dnsSecOK: true }, 1));
  });

  it("should encode an OPT record's rdata alone through getRawData, its fields in the header, and round-trip both", () => {
    const record = new OPTRecord(1440, [{ code: 1337, data: Buffer.from("hi") }], 1, { dnsSecOK: true, zero: 3 }, 2);

    expect(record.getRawData().toString("hex")).toBe("053900026869");
    runRecordEncodingTest(record);
  });

  // RFC 6891 6.1.3 packs the extended rcode, the version, the DO bit and the 15-bit Z into the TTL, so the high bit of each octet lands in the header.
  it("should write an OPT record with every high bit set to the bytes RFC 6891 6.1.2 lays out", () => {
    const record = new OPTRecord(1472, [], 0xff, { dnsSecOK: true, zero: 0x1234 }, 0x80);

    // The root name, the type 41, the payload size as the class, the TTL holding 0xff, 0x80 and DO with Z, and an empty rdata.
    expect(encodedHex(record)).toBe("00002905c0ff8092340000");
    runRecordEncodingTest(record);
  });

  // Z takes the 15 bits after the DO bit, so a Z of 0xffff is stored and written as 0x7fff. With DO clear the bit Z loses is the one DO would set, so the
  // wire bytes show the mask as the stored flags do.
  it("should store and write an OPT record's Z of 0xffff as its 15 bits", () => {
    const record = new OPTRecord(1472, [], 0, { zero: 0xffff });

    expect(record.flags.zero).toBe(0x7fff);
    expect(encodedHex(record)).toBe("00002905c000007fff0000");
    runRecordEncodingTest(record);
  });

  it("should encode PTR", () => {
    runRecordEncodingTest(new PTRRecord("test.local.", "test2.local."));
    runRecordEncodingTest(new PTRRecord("sub.test.local.", "test2.local."));
  });

  it("should encode SRV", () => {
    const unicastSRV = new SRVRecord("My Great Service._hap._tcp.local.", "test.local.", 8080);
    runRecordEncodingTest(unicastSRV, true);

    runRecordEncodingTest(new SRVRecord("My Great Service._hap._tcp.local.", "test.local.", 8080));
    runRecordEncodingTest(new SRVRecord("My Great Service2._hap._tcp.local.", "test2.local", 8081));
  });

  it("should encode TXT", () => {
    runRecordEncodingTest(new TXTRecord("test.local.", []));
    runRecordEncodingTest(new TXTRecord("test.local.", [Buffer.from("key=value")]));
    runRecordEncodingTest(new TXTRecord("test.local.", [Buffer.from("key=value"), Buffer.from("key2=value2")]));
  });

  // A record built by name keeps the TTL it is given, zero among them, and takes its type's default only when given none.
  it.each<[string, (ttl?: number) => ResourceRecord, number]>([
    ["A", ttl => new ARecord("host.local.", "192.0.2.1", true, ttl), ARecord.DEFAULT_TTL],
    ["AAAA", ttl => new AAAARecord("host.local.", "fe80::1", true, ttl), AAAARecord.DEFAULT_TTL],
    ["SRV", ttl => new SRVRecord("Test._hap._tcp.local.", "host.local.", 4711, true, ttl), SRVRecord.DEFAULT_TTL],
    ["NSEC", ttl => new NSECRecord("host.local.", "host.local.", [RType.A], ttl, true), NSECRecord.RR_DEFAULT_TTL_SHORT],
  ])("should keep a TTL of zero on an %s record built by name, and the default with none", (_type, build, defaultTTL) => {
    expect(build(0).ttl).toBe(0);
    expect(build().ttl).toBe(defaultTTL);
  });

  /* A received record is read to the end its RDLENGTH declares, so one whose decoder reads short or long is dropped, and the record after it decodes from
   * where the packet places it. Each packet holds the record under test for host.local., then an A record whose name is a compression pointer to that
   * name at offset 0, so the second record keeps its name only when its decode starts at its own first byte.
   */
  describe("a received record whose decoder reads a length other than its RDLENGTH", () => {
    const context: AddressInfo = { address: "192.0.2.9", family: "IPv4", port: 5353 };
    const hostLocal = [ 4, ...Buffer.from("host"), 5, ...Buffer.from("local"), 0 ];
    // The fields after a record's name: its type, the class IN, a TTL of 120 seconds and its RDLENGTH.
    const fields = (type: RType, rDataLength: number): number[] => [ 0, type, 0, 1, 0, 0, 0, 120, 0, rDataLength ];
    const pointedARecord = [ 0xc0, 0x00, ...fields(RType.A, 4), 192, 0, 2, 2 ];

    function decodePacket(first: number[]): { first: OptionalDecodedData<ResourceRecord>; second: OptionalDecodedData<ResourceRecord> } {
      const buffer = Buffer.from([ ...first, ...pointedARecord ]);
      const coder = new DNSLabelCoder();
      coder.initBuf(buffer);

      const firstRecord = ResourceRecord.decode(context, coder, buffer, 0);
      return { first: firstRecord, second: ResourceRecord.decode(context, coder, buffer, firstRecord.readBytes) };
    }

    it.each([
      ["an A record whose RDLENGTH runs a byte past its address", [ ...hostLocal, ...fields(RType.A, 5), 192, 0, 2, 1, 0 ]],
      ["a PTR record whose name runs past its RDLENGTH into the next record's pointer", [ ...hostLocal, ...fields(RType.PTR, 2), 1, ...Buffer.from("x") ]],
    ])("should drop %s and decode the record after it", (_record, first) => {
      const decoded = decodePacket(first);

      expect(decoded.first).toEqual({ readBytes: first.length });
      expect(decoded.second.readBytes).toBe(pointedARecord.length);
      expect(decoded.second.data?.name).toBe("host.local.");
      expect((decoded.second.data as ARecord).ipAddress).toBe("192.0.2.2");
    });

    /* A decoder that throws still clears the local compression location of its record. The record after it has an owner name of [ 0x80, 0x00 ], a local
     * pointer to its own first byte, which it reads before its own location is set, so a location left from the record before would resolve it to that
     * record's name at offset 0.
     */
    it("should clear the local compression location when a decoder throws, so the next record's name cannot resolve against it", () => {
      // An A record whose RDLENGTH of 2 cuts its address short, so its decoder throws reading past the rdata.
      const first = [ ...hostLocal, ...fields(RType.A, 2), 192, 0 ];
      const second = [ 0x80, 0x00, ...fields(RType.A, 4), 192, 0, 2, 2 ];
      const buffer = Buffer.from([ ...first, ...second ]);
      const coder = new DNSLabelCoder();
      coder.initBuf(buffer);

      const decoded = ResourceRecord.decode(context, coder, buffer, 0);

      expect(decoded).toEqual({ readBytes: first.length });
      expect(() => ResourceRecord.decode(context, coder, buffer, decoded.readBytes)).toThrow("Cannot decompress locally compressed name as record is not initialized!");
    });
  });

});
