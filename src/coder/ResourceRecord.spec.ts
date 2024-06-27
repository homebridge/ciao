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

  it("should encode IPv4-mapped IPv6 addresses in AAAA records", () => {
    runRecordEncodingTest(new AAAARecord("test.local.", "::ffff:192.168.178.1"));
    runRecordEncodingTest(new AAAARecord("sub.test.local.", "::ffff:192.168.0.1"));
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

});
