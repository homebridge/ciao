import { AAAARecord } from "../coder/records/AAAARecord";
import { ARecord } from "../coder/records/ARecord";
import { OPTRecord } from "../coder/records/OPTRecord";
import { TXTRecord } from "../coder/records/TXTRecord";
import { rrComparator, runTiebreaking, TiebreakingResult } from "./tiebreaking";

const printerHost = new ARecord("MyPrinter.local", "169.254.99.200");
const printerOpponent = new ARecord("MyPrinter.local", "169.254.200.50");
const differentClass = new ARecord("MyPrinter.local", "169.254.200.50");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
// noinspection JSConstantReassignment
differentClass.class = 3;
const differentType = new AAAARecord("MyPrinter.local", "169:254:99:200:72:9015:6be6:f9e2");
const shortData = new TXTRecord("MyPrinter.local", [Buffer.from("foo=bar")]); // TXT has higher numeric value than A
const longerData = new TXTRecord("MyPrinter.local", [Buffer.from("foo=bar"), Buffer.from("foo=baz")]);

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

    // The opponent's authorities in a received probe are sorted with this comparator, and two OPT records with one payload size are told apart by their
    // raw rdata, the options alone.
    it("should sort two OPT authorities of one payload size by their options", () => {
      const lower = new OPTRecord(1440, [{ code: 1, data: Buffer.from("a") }]);
      const higher = new OPTRecord(1440, [{ code: 1, data: Buffer.from("b") }]);

      expect([ higher, lower ].sort(rrComparator)).toEqual([ lower, higher ]);
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

    it("should decide on record type when the first unequal records differ in type", () => {
      expect(runTiebreaking([printerHost, printerOpponent], [printerHost, shortData])).toBe(TiebreakingResult.OPPONENT);
      expect(runTiebreaking([printerHost, shortData], [printerHost, printerOpponent])).toBe(TiebreakingResult.HOST);
    });

  });
});
