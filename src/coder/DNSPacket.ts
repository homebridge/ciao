import assert from "assert";
import deepEqual from "fast-deep-equal";
import { MDNSServer } from "../MDNSServer";
import { DNSLabelCoder } from "./DNSLabelCoder";
import { Question } from "./Question";
import "./records";
import { ResourceRecord } from "./ResourceRecord";

export const enum OpCode { // RFC 6895 2.2.
  QUERY = 0,
  // incomplete list
}

export const enum RCode { // RFC 6895 2.3.
  NoError = 0,
  // incomplete list
}

export const enum RType { // RFC 1035 3.2.2.
  A = 1,
  CNAME = 5,
  PTR = 12,
  TXT = 16,
  AAAA = 28, // RFC 3596 2.1.
  SRV = 33, // RFC 2782
  OPT = 41, // RFC 6891
  NSEC = 47, // RFC 4034 4.
  // incomplete list
}

export const enum QType { // RFC 1035 3.2.2. 3.2.3.
  A = 1,
  CNAME = 5,
  PTR = 12,
  TXT = 16,
  AAAA = 28, // RFC 3596 2.1.
  SRV = 33, // RFC 2782
  // OPT = 41, // RFC 6891
  NSEC = 47, // RFC 4034 4.
  ANY = 255,
  // incomplete list
}

export function dnsTypeToString(type: RType | QType): string {
  switch (type) {
    case 1:
      return "A";
    case 5:
      return "CNAME";
    case 12:
      return "PTR";
    case 16:
      return "TXT";
    case 28:
      return "AAAA";
    case 33:
      return "SRV";
    case 47:
      return "NSEC";
    case 255:
      return "ANY";
  }
  return "UNSUPPORTED";
}

export const enum RClass { // RFC 1035 3.2.4.
  IN = 1, // the internet
  // incomplete list
}

export const enum QClass { // RFC 1035 3.2.4. 3.2.5.
  IN = 1, // the internet
  ANY = 255,
  // incomplete list
}

export const enum PacketType {
  QUERY = 0,
  RESPONSE = 1, // 16th bit set
}

export interface DecodedData<T> {
  data: T;
  readBytes: number;
}

export interface DNSQueryDefinition {
  questions: Question[];
  answers?: ResourceRecord[]; // list of known-answers
}

export interface DNSProbeQueryDefinition {
  questions: Question[];
  authorities?: ResourceRecord[]; // use when sending probe queries to indicate what records we want to publish
}

export interface DNSResponseDefinition {
  id?: number; // must be zero, except when responding to unicast queries we need to match the supplied id
  questions?: Question[]; // must not be defined, though for unicast queries we MUST repeat the question
  answers: ResourceRecord[];
  additionals?: ResourceRecord[];
  legacyUnicast?: boolean, // used to define that we address and legacy unicast querier and thus need to handle that in encoding
}

function isQuery(query: DNSQueryDefinition | DNSProbeQueryDefinition): query is DNSQueryDefinition {
  return "answers" in query;
}

function isProbeQuery(query: DNSQueryDefinition | DNSProbeQueryDefinition): query is DNSProbeQueryDefinition {
  return "authorities" in query;
}

export interface PacketFlags {
  authoritativeAnswer?: boolean;
  truncation?: boolean;

  // below flags are all not used with mdns
  recursionDesired?: boolean;
  recursionAvailable?: boolean;
  zero?: boolean;
  authenticData?: boolean;
  checkingDisabled?: boolean;
}

export interface PacketDefinition {
  id?: number;
  legacyUnicast?: boolean;

  type: PacketType;
  opcode?: OpCode; // default QUERY
  flags?: PacketFlags;
  rCode?: RCode; // default NoError

  questions?: Question[];
  answers?: ResourceRecord[];
  authorities?: ResourceRecord[];
  additionals?: ResourceRecord[];
}

export interface DNSRecord {

  getEstimatedEncodingLength(): number;

  trackNames(coder: DNSLabelCoder, legacyUnicast: boolean): void;

  clearNameTracking(): void;

  getEncodingLength(coder: DNSLabelCoder): number;

  encode(coder: DNSLabelCoder, buffer: Buffer, offset: number): number;

}

export class DNSPacket {

  public static readonly MTU_IPV4 = (process.env.CIAO_MTU? parseInt(process.env.CIAO_MTU): 1500)
    - (MDNSServer.DEFAULT_IP4_HEADER + MDNSServer.UDP_HEADER);
  // noinspection JSUnusedGlobalSymbols
  public static readonly MTU_IPV6 = (process.env.CIAO_MTU? parseInt(process.env.CIAO_MTU): 1500)
    - (MDNSServer.DEFAULT_IP6_HEADER + MDNSServer.UDP_HEADER);

  private static readonly AUTHORITATIVE_ANSWER_MASK = 0x400;
  private static readonly TRUNCATION_MASK = 0x200;
  private static readonly RECURSION_DESIRED_MASK = 0x100;
  private static readonly RECURSION_AVAILABLE_MASK = 0x80;
  private static readonly ZERO_HEADER_MASK = 0x40;
  private static readonly AUTHENTIC_DATA_MASK = 0x20;
  private static readonly CHECKING_DISABLED_MASK = 0x10;

  // 2 bytes ID, 2 bytes flags, 2 bytes question count, 2 bytes answer count, 2 bytes authorities count; 2 bytes additionals count
  private static readonly DNS_PACKET_HEADER_SIZE = 12;

  id: number;
  private legacyUnicastEncoding: boolean;

  readonly type: PacketType;
  readonly opcode: OpCode;
  readonly flags: PacketFlags;
  readonly rcode: RCode;

  readonly questions: Question[];
  readonly answers: ResourceRecord[];
  readonly authorities: ResourceRecord[];
  readonly additionals: ResourceRecord[];

  private readonly labelCoder: DNSLabelCoder;
  private encodingMode = false;
  private estimatedPacketSize = 0; // only set in encoding mode

  constructor(definition: PacketDefinition) {
    this.id = definition.id || 0;
    this.legacyUnicastEncoding = definition.legacyUnicast || false;

    this.type = definition.type;
    this.opcode = definition.opcode || OpCode.QUERY;
    this.flags = definition.flags || {};
    this.rcode = definition.rCode || RCode.NoError;

    this.questions = definition.questions || [];
    this.answers = definition.answers || [];
    this.authorities = definition.authorities || [];
    this.additionals = definition.additionals || [];

    this.labelCoder = new DNSLabelCoder();
  }

  public static createDNSQueryPackets(definition: DNSQueryDefinition | DNSProbeQueryDefinition, mtu = this.MTU_IPV4): DNSPacket[] {
    const packets: DNSPacket[] = [];

    // packet is like the "main" packet
    const packet = new DNSPacket({
      type: PacketType.QUERY,
      questions: definition.questions,
    });
    packet.initEncodingMode();
    packets.push(packet);

    if (packet.getEstimatedEncodingLength() > mtu) {
      const compressedLength = packet.getEncodingLength(); // calculating the real length will update the estimated property as well
      if (compressedLength > mtu) {
        // if we are still above the MTU we have a problem
        assert.fail("Cannot send query where already the query section is exceeding the mtu (" + compressedLength + ">" + mtu +")!");
      }
    }

    // related https://en.wikipedia.org/wiki/Knapsack_problem

    if (isQuery(definition) && definition.answers) {
      let currentPacket = packet;
      let i = 0;
      const answers = definition.answers.concat([]); // concat basically creates a copy of the array
      // sort the answers ascending on their encoding length; otherwise we would need to check if a packets fits in a previously created packet
      answers.sort((a, b) => a.getEstimatedEncodingLength() - b.getEstimatedEncodingLength());

      // in the loop below, we check if we need to truncate the list of known-answers in the query

      while (i < answers.length) {
        for (; i < answers.length; i++) {
          const answer = answers[i];
          const estimatedSize = answer.getEstimatedEncodingLength();

          if (packet.getEstimatedEncodingLength() + estimatedSize <= mtu) { // size check on estimated calculations
            currentPacket.addAnswers(answer);
          } else if (packet.getEncodingLength() + estimatedSize <= mtu) { // check if the record may fit when message compression is used.
            // we may still have a false positive here, as the currently can't compute the REAL encoding for the answer
            // record, thus we rely on the estimated size
            currentPacket.addAnswers(answer);
          } else {
            if (currentPacket.questions.length === 0 && currentPacket.answers.length === 0) {
              // we encountered a record which is to big and can't fit in a mtu sized packet

              // RFC 6762 17. In the case of a single Multicast DNS resource record that is too
              //    large to fit in a single MTU-sized multicast response packet, a
              //    Multicast DNS responder SHOULD send the resource record alone, in a
              //    single IP datagram, using multiple IP fragments.
              packet.addAnswers(answer);
            }

            break;
          }
        }

        if (i < answers.length) { // if there are more records left, we need to truncate the packet again
          currentPacket.flags.truncation = true; // first of all, mark the previous packet as truncated
          currentPacket = new DNSPacket({ type: PacketType.QUERY });
          currentPacket.initEncodingMode();
          packets.push(currentPacket);
        }
      }
    } else if (isProbeQuery(definition) && definition.authorities) {
      packet.addAuthorities(...definition.authorities);
      const compressedLength = packet.getEncodingLength();

      if (compressedLength > mtu) {
        assert.fail(`Probe query packet exceeds the mtu size (${compressedLength}>${mtu}). Can't split probe queries at the moment!`);
      }
    } // otherwise, the packet consist of only questions

    return packets;
  }

  public static createDNSResponsePacketsFromRRSet(definition: DNSResponseDefinition, mtu = this.MTU_IPV4): DNSPacket {
    const packet = new DNSPacket({
      id: definition.id,
      legacyUnicast: definition.legacyUnicast,

      type: PacketType.RESPONSE,
      flags: { authoritativeAnswer: true }, // RFC 6763 18.4 AA is always set for responses in mdns
      // possible questions sent back to an unicast querier (unicast dns contain only one question, so no size problem here)
      questions: definition.questions,
      answers: definition.answers,
      additionals: definition.additionals,
    });
    packet.initEncodingMode();

    if (packet.getEncodingLength() > mtu) {
      assert.fail("Couldn't construct a dns response packet from a rr set!");
    }

    return packet;
  }

  public canBeCombinedWith(packet: DNSPacket, mtu = DNSPacket.MTU_IPV4): boolean {
    // packet header must be identical
    return this.id === packet.id && this.type === packet.type
      && this.opcode === packet.opcode && deepEqual(this.flags, packet.flags)
      && this.rcode === packet.rcode
      // and the data must fit into a mtu sized packet
      && this.getEncodingLength() + packet.getEncodingLength() <= mtu;
  }

  public combineWith(packet: DNSPacket): void {
    // below assert would be useful, but current codebase will check this in any case
    // so we leave it commented out for now
    // assert(this.canBeCombined(packet), "Tried combining packet which can not be combined!");

    this.legacyUnicastEncoding = this.legacyUnicastEncoding || packet.legacyUnicastEncoding;

    packet.clearNameTracking();

    this.addQuestions(...packet.questions);
    this.addAnswers(...packet.answers);
    this.addAuthorities(...packet.authorities);
    this.addAdditionals(...packet.additionals);
  }

  public addQuestions(...questions: Question[]): void {
    this.addRecords(this.questions, questions);
  }

  public addAnswers(...answers: ResourceRecord[]): void {
    this.addRecords(this.answers, answers);
  }

  public addAuthorities(...authorities: ResourceRecord[]): void {
    this.addRecords(this.authorities, authorities);
  }

  public addAdditionals(...additionals: ResourceRecord[]): void {
    this.addRecords(this.additionals, additionals);
  }

  private addRecords(recordList: DNSRecord[], added: DNSRecord[]): void {
    for (const record of added) {
      if (this.encodingMode) {
        record.clearNameTracking();
        record.trackNames(this.labelCoder, this.legacyUnicastEncoding);
        this.estimatedPacketSize += record.getEstimatedEncodingLength();
      }

      recordList.push(record);
    }
  }

  public replaceExistingAnswer(record: ResourceRecord): boolean {
    return this.replaceExistingRecord(this.answers, record);
  }

  public replaceExistingAdditional(record: ResourceRecord): boolean {
    return this.replaceExistingRecord(this.additionals, record);
  }

  public removeAboutSameAdditional(record: ResourceRecord): void {
    this.removeAboutSameRecord(this.additionals, record);
  }

  private replaceExistingRecord(recordList: ResourceRecord[], record: ResourceRecord): boolean {
    assert(!this.encodingMode, "Can't replace records when already in encoding mode!");

    let overwrittenSome = false;

    for (let i = 0; i < recordList.length; i++) {
      const record0 = recordList[i];

      if (record0.representsSameData(record)) {
        // A and AAAA records can be duplicate in one packet even though flush flag is set
        if (record.flushFlag && record.type !== RType.A && record.type !== RType.AAAA) {
          recordList[i] = record;
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

  private removeAboutSameRecord(recordList: ResourceRecord[], record: ResourceRecord): void {
    assert(!this.encodingMode, "Can't remove records when already in encoding mode!");

    for (let i = 0; i < recordList.length; i++) {
      const record0 = recordList[i];

      if (record0.representsSameData(record)) {
        // A and AAAA records can be duplicate in one packet even though flush flag is set
        if ((record.flushFlag && record.type !== RType.A && record.type !== RType.AAAA)
          || record0.dataEquals(record)) {
          recordList.splice(i, 1);
          break; // we can break, as assumption is that no equal records follow (does not contain duplicates)
        }
      }
    }
  }

  public setLegacyUnicastEncoding(legacyUnicastEncoding: boolean): void {
    assert(!this.encodingMode, "Can't change legacy unicast encoding flag when already in encoding mode!");
    this.legacyUnicastEncoding = legacyUnicastEncoding;
  }

  public legacyUnicastEncodingEnabled(): boolean {
    return this.legacyUnicastEncoding;
  }

  public initEncodingMode(): void {
    if (this.encodingMode) {
      return;
    }

    this.questions.forEach(question => question.trackNames(this.labelCoder, this.legacyUnicastEncoding));
    this.answers.forEach(record => record.trackNames(this.labelCoder, this.legacyUnicastEncoding));
    this.authorities.forEach(record => record.trackNames(this.labelCoder, this.legacyUnicastEncoding));
    this.additionals.forEach(record => record.trackNames(this.labelCoder, this.legacyUnicastEncoding));

    this.estimatedPacketSize = DNSPacket.DNS_PACKET_HEADER_SIZE;

    this.questions.forEach(question => this.estimatedPacketSize += question.getEstimatedEncodingLength());
    this.answers.forEach(record => this.estimatedPacketSize += record.getEstimatedEncodingLength());
    this.authorities.forEach(record => this.estimatedPacketSize += record.getEstimatedEncodingLength());
    this.additionals.forEach(record => this.estimatedPacketSize += record.getEstimatedEncodingLength());

    this.encodingMode = true;
  }

  private clearNameTracking() {
    this.estimatedPacketSize = 0;
    this.encodingMode = false;

    this.labelCoder.resetCoder();

    this.questions.forEach(record => record.clearNameTracking());
    this.answers.forEach(record => record.clearNameTracking());
    this.authorities.forEach(record => record.clearNameTracking());
    this.additionals.forEach(record => record.clearNameTracking());
  }

  private getEstimatedEncodingLength(): number {
    assert(this.encodingMode, "Can't calculate estimated encoding length when not in encoding mode!");
    return this.estimatedPacketSize; // returns the upper bound (<=) for the packet length
  }

  private getEncodingLength(): number {
    assert(this.encodingMode, "Can't calculate REAL encoding length when not in encoding mode!");

    let length = DNSPacket.DNS_PACKET_HEADER_SIZE;

    this.labelCoder.computeCompressionPaths(); // ensure we are up to date with all the latest information

    this.questions.forEach(question => length += question.getEncodingLength(this.labelCoder));
    this.answers.forEach(record => length += record.getEncodingLength(this.labelCoder));
    this.authorities.forEach(record => length += record.getEncodingLength(this.labelCoder));
    this.additionals.forEach(record => length += record.getEncodingLength(this.labelCoder));

    this.estimatedPacketSize = length; // if we calculate the REAL packet length we update the estimate as well

    return length;
  }

  public encode(): Buffer {
    this.initEncodingMode();

    const length = this.getEncodingLength();
    const buffer = Buffer.allocUnsafe(length);
    this.labelCoder.initBuf(buffer);

    let offset = 0;

    buffer.writeUInt16BE(this.id, offset);
    offset += 2;

    let flags = (this.type << 15) | (this.opcode << 11) | this.rcode;
    if (this.flags.authoritativeAnswer) {
      flags |= DNSPacket.AUTHORITATIVE_ANSWER_MASK;
    }
    if (this.flags.truncation) {
      flags |= DNSPacket.TRUNCATION_MASK;
    }
    if (this.flags.recursionDesired) {
      flags |= DNSPacket.RECURSION_DESIRED_MASK;
    }
    if (this.flags.recursionAvailable) {
      flags |= DNSPacket.RECURSION_AVAILABLE_MASK;
    }
    if (this.flags.zero) {
      flags |= DNSPacket.ZERO_HEADER_MASK;
    }
    if (this.flags.authenticData) {
      flags |= DNSPacket.AUTHENTIC_DATA_MASK;
    }
    if (this.flags.checkingDisabled) {
      flags |= DNSPacket.CHECKING_DISABLED_MASK;
    }
    buffer.writeUInt16BE(flags, offset);
    offset += 2;

    buffer.writeUInt16BE(this.questions.length, offset);
    offset += 2;
    buffer.writeUInt16BE(this.answers.length, offset);
    offset += 2;
    buffer.writeUInt16BE(this.authorities.length, offset);
    offset += 2;
    buffer.writeUInt16BE(this.additionals.length, offset);
    offset += 2;

    for (const question of this.questions) {
      const length = question.encode(this.labelCoder, buffer, offset);
      offset += length;
    }

    for (const record of this.answers) {
      const length = record.encode(this.labelCoder, buffer, offset);
      offset += length;
    }

    for (const record of this.authorities) {
      const length = record.encode(this.labelCoder, buffer, offset);
      offset += length;
    }

    for (const record of this.additionals) {
      const length = record.encode(this.labelCoder, buffer, offset);
      offset += length;
    }

    assert(offset === buffer.length, "Bytes written didn't match the buffer size!");

    this.clearNameTracking();

    return buffer;
  }

  public static decode(buffer: Buffer, offset = 0): DNSPacket {
    const labelCoder = new DNSLabelCoder();
    labelCoder.initBuf(buffer);

    const id = buffer.readUInt16BE(offset);
    offset += 2;

    const flags = buffer.readUInt16BE(offset);
    offset += 2;

    const questionLength = buffer.readUInt16BE(offset);
    offset += 2;
    const answerLength = buffer.readUInt16BE(offset);
    offset += 2;
    const authoritiesLength = buffer.readUInt16BE(offset);
    offset += 2;
    const additionalsLength = buffer.readUInt16BE(offset);
    offset += 2;

    const questions: Question[] = new Array(questionLength);
    const answers: ResourceRecord[] = new Array(answerLength);
    const authorities: ResourceRecord[] = new Array(authoritiesLength);
    const additionals: ResourceRecord[] = new Array(additionalsLength);


    for (let i = 0; i < questionLength; i++) {
      const decodedQuestion = Question.decode(labelCoder, buffer, offset);
      offset += decodedQuestion.readBytes;
      questions[i] = decodedQuestion.data;
    }

    for (let i = 0; i < answerLength; i++) {
      const decodedRecord = ResourceRecord.decode(labelCoder, buffer, offset);
      offset += decodedRecord.readBytes;
      answers[i] = decodedRecord.data;
    }
    for (let i = 0; i < authoritiesLength; i++) {
      const decodedRecord = ResourceRecord.decode(labelCoder, buffer, offset);
      offset += decodedRecord.readBytes;
      authorities[i] = decodedRecord.data;
    }
    for (let i = 0; i < additionalsLength; i++) {
      const decodedRecord = ResourceRecord.decode(labelCoder, buffer, offset);
      offset += decodedRecord.readBytes;
      additionals[i] = decodedRecord.data;
    }

    assert(offset === buffer.length, "Didn't read the full buffer (offset=" + offset +", length=" + buffer.length +")");

    const qr = (flags >> 15) as PacketType;
    const opcode = ((flags >> 11) & 0xf) as OpCode;
    const rCode = (flags & 0xf) as RCode;
    const packetFlags: PacketFlags = {};

    if (flags & this.AUTHORITATIVE_ANSWER_MASK) {
      packetFlags.authoritativeAnswer = true;
    }
    if (flags & this.TRUNCATION_MASK) {
      packetFlags.truncation = true;
    }
    if (flags & this.RECURSION_DESIRED_MASK) {
      packetFlags.recursionDesired = true;
    }
    if (flags & this.RECURSION_AVAILABLE_MASK) {
      packetFlags.recursionAvailable = true;
    }
    if (flags & this.ZERO_HEADER_MASK) {
      packetFlags.zero = true;
    }
    if (flags & this.AUTHENTIC_DATA_MASK) {
      packetFlags.authenticData = true;
    }
    if (flags & this.CHECKING_DISABLED_MASK) {
      packetFlags.checkingDisabled = true;
    }

    return new DNSPacket({
      id: id,

      type: qr,
      opcode: opcode,
      rCode: rCode,
      flags: packetFlags,

      questions: questions,
      answers: answers,
      authorities: authorities,
      additionals: additionals,
    });
  }

}
