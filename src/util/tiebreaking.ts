import dnsPacket, {DecodedAnswerRecord} from "@homebridge/dns-packet"; // TODO use custom type?

/**
 * Comparator for two ResourceRecords according to RFC 6762 8.2. "Simultaneous ProbeTiebreaking":
 *    The determination of "lexicographically later" is performed by first
 *    comparing the record class (excluding the cache-flush bit described
 *    in Section 10.2), then the record type, then raw comparison of the
 *    binary content of the rdata without regard for meaning or structure.
 *
 * @param recordA - record a
 * @param recordB - record b
 * @returns -1 if record a < record b, 0 if record a == record b, 1 if record a > record b
 */
export function rrComparator(recordA: DecodedAnswerRecord, recordB: DecodedAnswerRecord): number {
  // Get the numeric representation of the class
  const aClass = dnsPacket.classes.toClass(recordA.class);
  const bClass = dnsPacket.classes.toClass(recordB.class);

  if (aClass !== bClass) {
    return aClass < bClass? -1: 1;
  }

  // Get the numeric representation of the type
  const aType = dnsPacket.types.toType(recordA.type);
  const bType = dnsPacket.types.toType(recordB.type);

  if (aType !== bType) {
    return aType < bType? -1: 1;
  }

  // now follows a raw comparison of the binary data
  const aData = recordA.rawData;
  const bData = recordB.rawData;
  const maxLength = Math.max(aData.length, bData.length); // get the biggest length

  for (let i = 0; i < maxLength; i++) {
    if (i >= aData.length && i < bData.length) { // a ran out of data and b still holds data
      return -1;
    } else if (i >= bData.length && i < aData.length) { // b ran out of data and a still hold data
      return 1;
    }

    const aByte = aData.readUInt8(i);
    const bByte = bData.readUInt8(i);

    if (aByte !== bByte) {
      return aByte < bByte? -1: 1;
    }
  }

  // if we reach here we have a tie. both records represent the SAME data.
  return 0;
}

export const enum TiebreakingResult {
  /**
   * The opponent is considered the winner
   */
  OPPONENT = -1,
  /**
   * Both try to expose the exact same data
   */
  TIE = 0,
  /**
   * The host is considered the winner
   */
  HOST = 1,
}

/**
 * Runs the tiebreaking algorithm to resolve the race condition of simultaneous probing.
 * The input sets MUST already be sorted.
 *
 * @param {DecodedAnswerRecord[]} host - sorted list of records the host wants to publish
 * @param {DecodedAnswerRecord[]} opponent - sorted list of records the opponent wants to publish
 * @returns the result {@see TiebreakingResult} of the tiebreaking algorithm
 */
export function runTiebreaking(host: DecodedAnswerRecord[], opponent: DecodedAnswerRecord[]): TiebreakingResult {
  const maxLength = Math.max(host.length, opponent.length);

  for (let i = 0; i < maxLength; i++) {
    if (i >= host.length && i < opponent.length) { // host runs out of records and opponent still has some
      return TiebreakingResult.OPPONENT; // opponent wins
    } else if (i >= opponent.length && i < host.length) { // opponent runs out of records and host still has some
      return TiebreakingResult.HOST; // host wins
    }

    const recordComparison = rrComparator(host[i], opponent[i]);
    if (recordComparison !== 0) {
      return recordComparison;
    }
  }

  return TiebreakingResult.TIE; // they expose the exact same data
}
