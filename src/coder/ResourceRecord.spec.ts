import { RType } from "./DNSPacket";
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

describe(ResourceRecord, () => {
  it("should encode AAAA", () => {
    runRecordEncodingTest(new AAAARecord("test.local.", "::1"));
    runRecordEncodingTest(new AAAARecord("sub.test.local.", "fe80::14b0:44f7:b2ae:18e5"));
  });

  it("should encode A", () => {
    runRecordEncodingTest(new ARecord("test.local.", "192.168.178.1"));
    runRecordEncodingTest(new ARecord("sub.test.local.", "192.168.0.1"));
  });

  /*it("should encode IPv4-mapped IPv6 addresses in AAAA records", () => {
    runRecordEncodingTest(new AAAARecord("v4mapped.local.", "::ffff:192.168.178.1"));
    runRecordEncodingTest(new AAAARecord("sub.v4mapped.local.", "::ffff:192.168.0.1"));
  });*/

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

});
