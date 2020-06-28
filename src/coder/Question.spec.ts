import { QType } from "./DNSPacket";
import { Question } from "./Question";
import { runCompressionSanityChecks, runRecordEncodingTest } from "./test-utils";


describe(Question, () => {
  it("should run automatic coder tests", () => {
    runRecordEncodingTest(new Question("test.local.", QType.AAAA));
    runRecordEncodingTest(new Question("asfdf._test._tcp.local.", QType.A));
    runRecordEncodingTest(new Question("asdkjd._ajsdj.local.", QType.CNAME));
    runRecordEncodingTest(new Question("testasd.local.", QType.NSEC));
    runRecordEncodingTest(new Question("testff.wsdasd.f.local.", QType.PTR));
    runRecordEncodingTest(new Question("testasd.lasd.asd.local.", QType.SRV));
    runRecordEncodingTest(new Question("test 2asdf.asdkasd.local.", QType.TXT));
    runRecordEncodingTest(new Question("testasd.local.", QType.ANY));

    runCompressionSanityChecks(new Question("test.local", QType.PTR));
  });

});
