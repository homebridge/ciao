import { ResourceRecord } from "../coder/ResourceRecord";
import { PTRRecord } from "../coder/records/PTRRecord";
import { SRVRecord } from "../coder/records/SRVRecord";
import { TXTRecord } from "../coder/records/TXTRecord";
import { QueryResponse } from "./QueryResponse";

// The known-answer list of a query, keyed as DNSPacket keys the records it decodes.
function knownAnswers(...records: ResourceRecord[]): Map<string, ResourceRecord> {
  return new Map(records.map(record => [ record.asString(), record ]));
}

describe(QueryResponse, () => {
  describe("known-answer suppression (RFC 6762 7.1)", () => {
    it("leaves out an answer the querier lists with the same spelling", () => {
      const response = new QueryResponse(knownAnswers(new PTRRecord("_hap._tcp.local.", "Kitchen._hap._tcp.local.")));

      expect(response.addAnswer(new PTRRecord("_hap._tcp.local.", "Kitchen._hap._tcp.local."))).toBe(false);
      expect(response.hasAnswers()).toBe(false);
    });

    it("leaves out an answer the querier lists in another letter case, in its name and in the names its data holds", () => {
      const response = new QueryResponse(knownAnswers(
        new PTRRecord("_HAP._TCP.local.", "KITCHEN._hap._tcp.LOCAL."),
        new SRVRecord("KITCHEN._hap._tcp.local.", "KITCHEN.LOCAL.", 4711),
      ));

      expect(response.addAnswer(new PTRRecord("_hap._tcp.local.", "Kitchen._hap._tcp.local."))).toBe(false);
      expect(response.addAdditional(new SRVRecord("Kitchen._hap._tcp.local.", "Kitchen.local.", 4711, true))).toBe(false);
      expect(response.hasAnswers()).toBe(false);
    });

    it("still sends an answer whose data differs from the known answer of the same name", () => {
      const response = new QueryResponse(knownAnswers(
        new PTRRecord("_HAP._tcp.local.", "Bedroom._hap._tcp.local."),
        new SRVRecord("KITCHEN._hap._tcp.local.", "Kitchen.local.", 4712),
        new TXTRecord("KITCHEN._hap._tcp.local.", [Buffer.from("a=1")]),
      ));

      expect(response.addAnswer(new PTRRecord("_hap._tcp.local.", "Kitchen._hap._tcp.local."))).toBe(true);
      expect(response.addAnswer(new SRVRecord("Kitchen._hap._tcp.local.", "Kitchen.local.", 4711, true))).toBe(true);
      expect(response.addAnswer(new TXTRecord("Kitchen._hap._tcp.local.", [Buffer.from("a=2")], true))).toBe(true);
    });

    it("still sends an answer the querier knows with half its ttl or less", () => {
      const response = new QueryResponse(knownAnswers(new PTRRecord("_HAP._tcp.local.", "Kitchen._hap._tcp.local.", false, 2250)));

      expect(response.addAnswer(new PTRRecord("_hap._tcp.local.", "Kitchen._hap._tcp.local."))).toBe(true);
    });
  });

  describe("additionals", () => {
    it("leaves out an additional the answer section already holds", () => {
      const response = new QueryResponse();
      const srv = new SRVRecord("Kitchen._hap._tcp.local.", "Kitchen.local.", 4711, true);

      expect(response.addAnswer(srv)).toBe(true);
      expect(response.addAdditional(srv.clone())).toBe(false);
      expect(response.asPacket().additionals.size).toBe(0);
    });

    it("marks a response shared once it holds an answer without the cache-flush bit", () => {
      const response = new QueryResponse();

      response.addAnswer(new SRVRecord("Kitchen._hap._tcp.local.", "Kitchen.local.", 4711, true));
      expect(response.containsSharedAnswer()).toBe(false);

      response.addAnswer(new PTRRecord("_hap._tcp.local.", "Kitchen._hap._tcp.local."));
      expect(response.containsSharedAnswer()).toBe(true);
    });
  });
});
