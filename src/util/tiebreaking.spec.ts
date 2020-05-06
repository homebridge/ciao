import dnsPacket, {AAAARecord, ARecord, Class, TXTRecord, Type} from "@homebridge/dns-packet";
import {rrComparator, runTiebreaking, TiebreakingResult} from "./tiebreaking";

const aRecord0: ARecord = {
  name: "MyPrinter.local",
  type: Type.A,
  ttl: 120,
  data: "169.254.99.200",
};
const aRecord1: ARecord = {
  name: "MyPrinter.local",
  type: Type.A,
  ttl: 120,
  data: "169.254.200.50",
};
const aRecord2: ARecord = {
  name: "MyPrinter.local",
  class: Class.CH, // class 3
  type: Type.A,
  ttl: 120,
  data: "169.254.200.50",
};
const aaaaRecord3: AAAARecord = {
  name: "MyPrinter.local",
  type: Type.AAAA, // higher numeric value than A
  ttl: 120,
  data: "169:254:99:200:72:9015:6be6:f9e2",
};
const txtRecord0: TXTRecord = {
  name: "MyPrinter.local",
  type: Type.TXT, // higher numeric value than A
  ttl: 120,
  data: ["foo=bar"],
};
const txtRecord1: TXTRecord = {
  name: "MyPrinter.local",
  type: Type.TXT, // higher numeric value than A
  ttl: 120,
  data: ["foo=bar", "foo=baz"],
};

const decodedRecords = dnsPacket.decode(dnsPacket.encode({
  answers: [aRecord0, aRecord1, aRecord2, aaaaRecord3, txtRecord0, txtRecord1],
})).answers;

const printerHost = decodedRecords[0];
const printerOpponent = decodedRecords[1];
const differentClass = decodedRecords[2];
const differentType = decodedRecords[3];

const shortData = decodedRecords[4];
const longerData = decodedRecords[5];
// pretty much every record is length prefixed. So to test the correctly handling
// of identical data but one exceeding the length of the other, we craft some malformed data
longerData.rawData[1] = shortData.rawData[1];

describe("tiebreaking", () => {
  describe(rrComparator, () => {

    it("should compare A records correctly", () => {
      expect(rrComparator(printerHost, printerOpponent)).toBe(-1);
      expect(rrComparator(printerOpponent, printerHost)).toBe(1);
    });

    it("should detect tie correctly", () => {
      expect(rrComparator(printerHost, printerHost)).toBe(0);
      expect(rrComparator(printerOpponent, printerOpponent)).toBe(0);
    });

    it("should correctly decide on class", () => {
      expect(rrComparator(printerHost, differentClass)).toBe(-1);
      expect(rrComparator(differentClass, printerHost)).toBe(1);
    });

    it("should correctly decide on type", () => {
      expect(rrComparator(printerHost, differentType)).toBe(-1);
      expect(rrComparator(differentType, printerHost)).toBe(1);
    });

    it("should correctly decide on data length", () => {
      expect(rrComparator(shortData, longerData)).toBe(-1);
      expect(rrComparator(longerData, shortData)).toBe(1);
    });

  });

  describe(runTiebreaking, () => {

    it("should decide on winner correctly", () => {
      expect(runTiebreaking([printerHost], [printerOpponent])).toBe(TiebreakingResult.OPPONENT);
      expect(runTiebreaking([printerOpponent], [printerHost])).toBe(TiebreakingResult.HOST);
    });

    it("should result in tie with same data", () => {
      const data  = [printerHost, printerOpponent, differentType, differentClass];
      expect(runTiebreaking(data, data)).toBe(TiebreakingResult.TIE);
    });

    it("should win with the same records but more data", () => {
      expect(runTiebreaking([printerHost], [printerHost, differentType])).toBe(TiebreakingResult.OPPONENT);
      expect(runTiebreaking([printerHost, differentType], [printerHost])).toBe(TiebreakingResult.HOST);
    });

  });
});
