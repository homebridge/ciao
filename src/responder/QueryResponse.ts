import { DNSPacket, PacketType } from "../coder/DNSPacket";
import { Question } from "../coder/Question";
import { ResourceRecord } from "../coder/ResourceRecord";

export type RecordAddMethod = (...records: ResourceRecord[]) => boolean;

export class QueryResponse {

  private readonly dnsPacket: DNSPacket;

  knownAnswers?: ResourceRecord[];
  private sharedAnswer = false;

  constructor() {
    this.dnsPacket = new DNSPacket({ type: PacketType.RESPONSE });
  }

  public defineKnownAnswers(records: ResourceRecord[]): void {
    this.knownAnswers = records;
  }

  public asPacket(): DNSPacket {
    return this.dnsPacket;
  }

  public asString(udpPayloadSize?: number): string {
    return this.dnsPacket.asLoggingString(udpPayloadSize);
  }

  public containsSharedAnswer(): boolean {
    return this.sharedAnswer;
  }

  public addAnswer(...records: ResourceRecord[]): boolean {
    let addedAny = false;

    for (const record of records) {
      if (this.isKnownAnswer(record)) {
        // record is a known answer to the querier
        continue;
      }

      const overwritten = this.dnsPacket.replaceExistingAnswer(record);
      addedAny = true;

      if (!overwritten) {
        if (!record.flushFlag) {
          this.sharedAnswer = true;
        }

        this.dnsPacket.addAnswers(record);
      }

      this.dnsPacket.removeAboutSameAdditional(record);
    }

    return addedAny;
  }

  public addAdditional(...records: ResourceRecord[]): boolean {
    let addedAny = false;

    for (const record of records) {
      if (this.isKnownAnswer(record)) {
        // check if the additional record is a known answer, otherwise there is no need to send it
        continue;
      }

      const overwrittenAnswer = this.dnsPacket.replaceExistingAnswer(record);

      // if it is already in the answer section, don't include it in additionals
      if (!overwrittenAnswer) {
        const overwrittenAdditional = this.dnsPacket.replaceExistingAdditional(record);
        if (!overwrittenAdditional) {
          this.dnsPacket.addAdditionals(record);
          addedAny = true;
        } else {
          addedAny = true;
        }
      } else {
        addedAny = true;
      }
    }

    return addedAny;
  }

  public markLegacyUnicastResponse(id: number, questions?: Question[]): void {
    // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
    //  * MUSTS: response via unicast, repeat query ID, repeat questions (actually it should just be one), clear cache flush bit
    //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism
    this.dnsPacket.id = id;
    if (questions) {
      this.dnsPacket.addQuestions(...questions);
    }

    this.dnsPacket.answers.forEach(answers => {
      answers.flushFlag = false;
      answers.ttl = 10;
    });
    this.dnsPacket.additionals.forEach(answers => {
      answers.flushFlag = false;
      answers.ttl = 10;
    });

    this.dnsPacket.setLegacyUnicastEncoding(true); // legacy unicast also affects the encoder (must not use compression for the SRV record) so we need to tell him
  }

  public markTruncated(): void {
    this.dnsPacket.flags.truncation = true;
  }

  public hasAnswers(): boolean {
    // we may still have additionals, though there is no reason when answers is empty
    // removeKnownAnswer may have removed all answers and only additionals are known.
    return this.dnsPacket.answers.length > 0;
  }

  private isKnownAnswer(record: ResourceRecord): boolean {
    if (!this.knownAnswers) {
      return false;
    }

    for (const knownAnswer of this.knownAnswers) {
      if (knownAnswer.aboutEqual(record)) {
        // we will still send the response if the known answer has half of the original ttl according to RFC 6762 7.1.
        // so only if the ttl is more than half than the original ttl we consider it a valid known answer
        if (knownAnswer.ttl > record.ttl / 2) {
          return true;
        }
      }
    }

    return false;
  }

  public static combineResponses(responses: QueryResponse[], udpPayloadSize?: number): void {
    for (let i = 0; i < responses.length - 1; i++) {
      const current = responses[i];
      const currentPacket = current.dnsPacket;
      const next = responses[i + 1];
      const nextPacket = next.dnsPacket;

      if (currentPacket.canBeCombinedWith(nextPacket, udpPayloadSize)) {
        // combine the packet with next one
        currentPacket.combineWith(nextPacket);

        // remove next from the array
        responses.splice(i + 1, 1);

        // we won't combine the known answer section, with current implementation they will always be the same
        current.sharedAnswer = current.sharedAnswer || next.sharedAnswer;

        // decrement i, so we check again if the "current" packet can be combined with the packet after "next"
        i--;
      }
    }
  }

}
