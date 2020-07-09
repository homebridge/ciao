import { DNSResponseDefinition, RType } from "../coder/DNSPacket";
import { Question } from "../coder/Question";
import { ResourceRecord } from "../coder/ResourceRecord";

export type RecordAddMethod = (...records: ResourceRecord[]) => boolean;

export class QueryResponse implements DNSResponseDefinition {

  id?: number;
  questions?: Question[];
  answers: ResourceRecord[] = [];
  additionals: ResourceRecord[] = [];
  legacyUnicast?: boolean;

  private knownAnswers?: ResourceRecord[];

  public defineKnownAnswers(records: ResourceRecord[]): void {
    this.knownAnswers = records;
  }

  public addAnswer(...records: ResourceRecord[]): boolean {
    let addedAny = false;

    for (const record of records) {
      const overwritten = QueryResponse.replaceExistingRecord(this.answers, record);

      if (!overwritten) {
        // check if the record to be added is not a known answer
        if (!this.isKnownAnswer(record)) {
          this.answers.push(record);
          addedAny = true;
        }
      } else {
        addedAny = true;
      }

      QueryResponse.removeAboutSameRecord(this.additionals, record);
    }

    return addedAny;
  }

  public addAdditional(...records: ResourceRecord[]): boolean {
    let addedAny = false;

    for (const record of records) {
      const overwrittenAnswer = QueryResponse.replaceExistingRecord(this.answers, record);

      // if it is already in the answer section, don't include it in additionals
      if (!overwrittenAnswer) {
        const overwrittenAdditional = QueryResponse.replaceExistingRecord(this.additionals, record);
        if (!overwrittenAdditional) {
          // check if the additional record is a known answer, otherwise there is no need to send it
          if (!this.isKnownAnswer(record)) {
            this.additionals.push(record);
            addedAny = true;
          }
        } else {
          addedAny = true;
        }
      } else {
        addedAny = true;
      }
    }

    return addedAny;
  }

  public markLegacyUnicastResponse(id: number, questions: Question[], multicastResponse: QueryResponse): void {
    // we are dealing with a legacy unicast dns query (RFC 6762 6.7.)
    //  * MUSTS: response via unicast, repeat query ID, repeat questions (actually it should just be one), clear cache flush bit
    //  * SHOULDS: ttls should not be greater than 10s as legacy resolvers don't take part in the cache coherency mechanism
    this.addAnswer(...multicastResponse.answers);
    this.addAdditional(...multicastResponse.additionals);
    multicastResponse.clear();

    this.id = id;
    this.questions = questions;

    this.answers.forEach(answers => {
      answers.flushFlag = false;
      answers.ttl = 10;
    });
    this.additionals?.forEach(answers => {
      answers.flushFlag = false;
      answers.ttl = 10;
    });

    this.legacyUnicast = true; // legacy unicast also affects the encoder (must not use compression for the SRV record) so we need to tell him
  }

  public hasAnswers(): boolean {
    // we may still have additionals, though there is no reason when answers is empty
    // removeKnownAnswer may have removed all answers and only additionals are known.
    return this.answers.length > 0;
  }

  private clear(): void {
    this.answers.splice(0, this.answers.length);
    this.additionals.splice(0, this.additionals.length);
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

  private static replaceExistingRecord(records: ResourceRecord[], record: ResourceRecord): boolean {
    let overwrittenSome = false;

    for (let i = 0; i < records.length; i++) {
      const record0 = records[i];

      if (record0.representsSameData(record)) {
        // A and AAAA records can be duplicate in one packet even though flush flag is set
        if (record.flushFlag && record.type !== RType.A && record.type !== RType.AAAA) {
          records[i] = record;
          overwrittenSome = true;
          break;
        } else if (record0.dataEquals(record)) {
          // flush flag is not set, but it is the same data thus the SAME record
          record0.ttl = record.ttl;
          overwrittenSome = true;
          break;
        }
      }
    }

    return overwrittenSome;
  }

  private static removeAboutSameRecord(records: ResourceRecord[], record: ResourceRecord): void {
    let i = 0;
    for (; i < records.length; i++) {
      const record0 = records[i];

      if (record0.representsSameData(record)) {
        // A and AAAA records can be duplicate in one packet even though flush flag is set
        if ((record.flushFlag && record.type !== RType.A && record.type !== RType.AAAA)
          || record0.dataEquals(record)) {
          break; // we can break, as assumption is that no equal records follow (does not contain duplicates)
        }
      }
    }

    if (i < records.length) {
      records.splice(i, 1);
    }
  }

}
