import assert from "assert";
import deepEqual from "fast-deep-equal";
import { AddressInfo } from "net";
import { dnsTypeToString } from "./dns-string-utils";
import { DNSLabelCoder, NonCompressionLabelCoder } from "./DNSLabelCoder";
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

export interface OptionalDecodedData<T> {
  data?: T;
  readBytes: number;
}

export interface DNSQueryDefinition {
  questions: Question[];
  answers?: ResourceRecord[]; // list of known-answers
  additionals?: ResourceRecord[]; // only really used to include the OPT record
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

  getEncodingLength(coder: DNSLabelCoder): number;

  encode(coder: DNSLabelCoder, buffer: Buffer, offset: number): number;

  asString(): string;

}

export class DNSPacket {

  public static readonly UDP_PAYLOAD_SIZE_IPV4 = (process.env.CIAO_UPS? parseInt(process.env.CIAO_UPS): 1440);
  // noinspection JSUnusedGlobalSymbols
  public static readonly UDP_PAYLOAD_SIZE_IPV6 = (process.env.CIAO_UPS? parseInt(process.env.CIAO_UPS): 1440);

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

  readonly questions: Map<string, Question> = new Map();
  readonly answers: Map<string, ResourceRecord> = new Map();
  readonly authorities: Map<string, ResourceRecord> = new Map();
  readonly additionals: Map<string, ResourceRecord> = new Map();

  private estimatedEncodingLength = 0; // upper bound for the resulting encoding length, should only be called via the getter
  private lastCalculatedLength = 0;
  private lengthDirty = true;

  constructor(definition: PacketDefinition) {
    this.id = definition.id || 0;
    this.legacyUnicastEncoding = definition.legacyUnicast || false;

    this.type = definition.type;
    this.opcode = definition.opcode || OpCode.QUERY;
    this.flags = definition.flags || {};
    this.rcode = definition.rCode || RCode.NoError;

    if (this.type === PacketType.RESPONSE) {
      this.flags.authoritativeAnswer = true; // RFC 6763 18.4 AA is always set for responses in mdns
    }

    if (definition.questions) {
      this.addQuestions(...definition.questions);
    }
    if (definition.answers) {
      this.addAnswers(...definition.answers);
    }
    if (definition.authorities) {
      this.addAuthorities(...definition.authorities);
    }
    if (definition.additionals) {
      this.addAdditionals(...definition.additionals);
    }
  }

  public static createDNSQueryPacket(definition: DNSQueryDefinition | DNSProbeQueryDefinition, udpPayloadSize = this.UDP_PAYLOAD_SIZE_IPV4): DNSPacket {
    const packets = this.createDNSQueryPackets(definition, udpPayloadSize);
    assert(packets.length === 1, "Cannot user short method createDNSQueryPacket when query packets are more than one: is " + packets.length);
    return packets[0];
  }

  public static createDNSQueryPackets(definition: DNSQueryDefinition | DNSProbeQueryDefinition, udpPayloadSize = this.UDP_PAYLOAD_SIZE_IPV4): DNSPacket[] {
    const packets: DNSPacket[] = [];

    // packet is like the "main" packet
    const packet = new DNSPacket({
      type: PacketType.QUERY,
      questions: definition.questions,
      additionals: isQuery(definition)? definition.additionals: undefined, // OPT record is included in additionals section
    });
    packets.push(packet);

    if (packet.getEstimatedEncodingLength() > udpPayloadSize) {
      const compressedLength = packet.getEncodingLength(); // calculating the real length will update the estimated property as well
      if (compressedLength > udpPayloadSize) {
        // if we are still above the payload size we have a problem
        assert.fail("Cannot send query where already the query section is exceeding the udpPayloadSize (" + compressedLength + ">" + udpPayloadSize +")!");
      }
    }

    // related https://en.wikipedia.org/wiki/Knapsack_problem

    if (isQuery(definition) && definition.answers) {
      let currentPacket = packet;
      let i = 0;
      const answers = definition.answers.concat([]); // concat basically creates a copy of the array
      // sort the answers ascending on their encoding length; otherwise we would need to check if a packets fits in a previously created packet
      answers.sort((a, b) => {
        return a.getEncodingLength(NonCompressionLabelCoder.INSTANCE) - b.getEncodingLength(NonCompressionLabelCoder.INSTANCE);
      });

      // in the loop below, we check if we need to truncate the list of known-answers in the query

      while (i < answers.length) {
        for (; i < answers.length; i++) {
          const answer = answers[i];
          const estimatedSize = answer.getEncodingLength(NonCompressionLabelCoder.INSTANCE);

          if (packet.getEstimatedEncodingLength() + estimatedSize <= udpPayloadSize) { // size check on estimated calculations
            currentPacket.addAnswers(answer);
          } else if (packet.getEncodingLength() + estimatedSize <= udpPayloadSize) { // check if the record may fit when message compression is used.
            // we may still have a false positive here, as the currently can't compute the REAL encoding for the answer
            // record, thus we rely on the estimated size
            currentPacket.addAnswers(answer);
          } else {
            if (currentPacket.questions.size === 0 && currentPacket.answers.size === 0) {
              // we encountered a record which is to big and can't fit in a udpPayloadSize sized packet

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
          packets.push(currentPacket);
        }
      }
    } else if (isProbeQuery(definition) && definition.authorities) {
      packet.addAuthorities(...definition.authorities);
      const compressedLength = packet.getEncodingLength();

      if (compressedLength > udpPayloadSize) {
        assert.fail(`Probe query packet exceeds the mtu size (${compressedLength}>${udpPayloadSize}). Can't split probe queries at the moment!`);
      }
    } // otherwise, the packet consist of only questions

    return packets;
  }

  public static createDNSResponsePacketsFromRRSet(definition: DNSResponseDefinition, udpPayloadSize = this.UDP_PAYLOAD_SIZE_IPV4): DNSPacket {
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

    if (packet.getEncodingLength() > udpPayloadSize) {
      assert.fail("Couldn't construct a dns response packet from a rr set which fits in an udp payload sized packet!");
    }

    return packet;
  }

  public canBeCombinedWith(packet: DNSPacket, udpPayloadSize = DNSPacket.UDP_PAYLOAD_SIZE_IPV4): boolean {
    // packet header must be identical
    return this.id === packet.id && this.type === packet.type
      && this.opcode === packet.opcode && deepEqual(this.flags, packet.flags)
      && this.rcode === packet.rcode
      // and the data must fit into a udpPayloadSize sized packet
      && this.getEncodingLength() + packet.getEncodingLength() <= udpPayloadSize;
  }

  public combineWith(packet: DNSPacket): void {
    this.setLegacyUnicastEncoding(this.legacyUnicastEncoding || packet.legacyUnicastEncoding);

    this.addRecords(this.questions, packet.questions.values());
    this.addRecords(this.answers, packet.answers.values(), this.additionals);
    this.addRecords(this.authorities, packet.authorities.values());
    this.addRecords(this.additionals, packet.additionals.values());
  }

  public addQuestions(...questions: Question[]): boolean {
    return this.addRecords(this.questions, questions);
  }

  public addAnswers(...answers: ResourceRecord[]): boolean {
    return this.addRecords(this.answers, answers, this.additionals);
  }

  public addAuthorities(...authorities: ResourceRecord[]): boolean {
    return this.addRecords(this.authorities, authorities);
  }

  public addAdditionals(...additionals: ResourceRecord[]): boolean {
    return this.addRecords(this.additionals, additionals);
  }

  private addRecords(recordList: Map<string, DNSRecord>, added: DNSRecord[] | IterableIterator<DNSRecord>, removeFromWhenAdded?: Map<string, DNSRecord>): boolean {
    let addedAny = false;

    for (const record of added) {
      if (recordList.has(record.asString())) {
        continue;
      }

      if (this.estimatedEncodingLength) {
        this.estimatedEncodingLength += record.getEncodingLength(NonCompressionLabelCoder.INSTANCE);
      }

      recordList.set(record.asString(), record);

      addedAny = true;
      this.lengthDirty = true;

      if (removeFromWhenAdded) {
        removeFromWhenAdded.delete(record.asString());
      }
    }

    return addedAny;
  }

  public setLegacyUnicastEncoding(legacyUnicastEncoding: boolean): void {
    if (this.legacyUnicastEncoding !== legacyUnicastEncoding) {
      this.lengthDirty = true; // above option changes length of SRV records
    }
    this.legacyUnicastEncoding = legacyUnicastEncoding;
  }

  public legacyUnicastEncodingEnabled(): boolean {
    return this.legacyUnicastEncoding;
  }

  private getEstimatedEncodingLength(): number {
    if (this.estimatedEncodingLength) {
      return this.estimatedEncodingLength;
    }

    const labelCoder = NonCompressionLabelCoder.INSTANCE;
    let length = DNSPacket.DNS_PACKET_HEADER_SIZE;

    for (const record of this.questions.values()) {
      length += record.getEncodingLength(labelCoder);
    }
    for (const record of this.answers.values()) {
      length += record.getEncodingLength(labelCoder);
    }
    for (const record of this.authorities.values()) {
      length += record.getEncodingLength(labelCoder);
    }
    for (const record of this.additionals.values()) {
      length += record.getEncodingLength(labelCoder);
    }

    this.estimatedEncodingLength = length;

    return length;
  }

  private getEncodingLength(coder?: DNSLabelCoder): number {
    if (!this.lengthDirty) {
      return this.lastCalculatedLength;
    }

    const labelCoder = coder || new DNSLabelCoder(this.legacyUnicastEncoding);

    let length = DNSPacket.DNS_PACKET_HEADER_SIZE;

    for (const record of this.questions.values()) {
      length += record.getEncodingLength(labelCoder);
    }
    for (const record of this.answers.values()) {
      length += record.getEncodingLength(labelCoder);
    }
    for (const record of this.authorities.values()) {
      length += record.getEncodingLength(labelCoder);
    }
    for (const record of this.additionals.values()) {
      length += record.getEncodingLength(labelCoder);
    }

    this.lengthDirty = false; // reset dirty flag
    this.lastCalculatedLength = length;
    this.estimatedEncodingLength = length;

    return length;
  }

  public encode(): Buffer {
    const labelCoder = new DNSLabelCoder(this.legacyUnicastEncoding);

    const length = this.getEncodingLength(labelCoder);
    const buffer = Buffer.allocUnsafe(length);

    labelCoder.initBuf(buffer);

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

    buffer.writeUInt16BE(this.questions.size, offset);
    offset += 2;
    buffer.writeUInt16BE(this.answers.size, offset);
    offset += 2;
    buffer.writeUInt16BE(this.authorities.size, offset);
    offset += 2;
    buffer.writeUInt16BE(this.additionals.size, offset);
    offset += 2;

    for (const question of this.questions.values()) {
      const length = question.encode(labelCoder, buffer, offset);
      offset += length;
    }

    for (const record of this.answers.values()) {
      const length = record.encode(labelCoder, buffer, offset);
      offset += length;
    }

    for (const record of this.authorities.values()) {
      const length = record.encode(labelCoder, buffer, offset);
      offset += length;
    }

    for (const record of this.additionals.values()) {
      const length = record.encode(labelCoder, buffer, offset);
      offset += length;
    }

    assert(offset === buffer.length, "Bytes written didn't match the buffer size!");

    return buffer;
  }

  public static decode(context: AddressInfo, buffer: Buffer, offset = 0): DNSPacket {
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

    const questions: Question[] = [];
    const answers: ResourceRecord[] = [];
    const authorities: ResourceRecord[] = [];
    const additionals: ResourceRecord[] = [];


    offset += DNSPacket.decodeList(context, labelCoder, buffer, offset, questionLength, Question.decode.bind(Question), questions);
    offset += DNSPacket.decodeList(context, labelCoder, buffer, offset, answerLength, ResourceRecord.decode.bind(ResourceRecord), answers);
    offset += DNSPacket.decodeList(context, labelCoder, buffer, offset, authoritiesLength, ResourceRecord.decode.bind(ResourceRecord), authorities);
    offset += DNSPacket.decodeList(context, labelCoder, buffer, offset, additionalsLength, ResourceRecord.decode.bind(ResourceRecord), additionals);

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

  private static decodeList<T>(context: AddressInfo, coder: DNSLabelCoder, buffer: Buffer, offset: number,
    length: number, decoder: (context: AddressInfo, coder: DNSLabelCoder, buffer: Buffer, offset: number) => OptionalDecodedData<T>, destination: T[]): number {
    const oldOffset = offset;

    for (let i = 0; i < length; i++) {
      const decoded = decoder(context, coder, buffer, offset);
      offset += decoded.readBytes;

      if (decoded.data) { // if the rdata is not supported by us or we encountered an parsing error, we ignore the record
        destination.push(decoded.data);
      }
    }

    return offset - oldOffset;
  }

  public asLoggingString(udpPayloadSize?: number): string {
    let answerString = "";
    let additionalsString = "";

    for (const record of this.answers.values()) {
      if (answerString) {
        answerString += ",";
      }
      answerString += dnsTypeToString(record.type);
    }
    for (const record of this.additionals.values()) {
      if (additionalsString) {
        additionalsString += ",";
      }
      additionalsString += dnsTypeToString(record.type);
    }

    const optionsStrings: string[] = [];
    if (this.legacyUnicastEncodingEnabled()) {
      optionsStrings.push("U");
    }
    if (udpPayloadSize) {
      optionsStrings.push("UPS: " + udpPayloadSize);
    }

    const optionsString = optionsStrings.length !== 0? ` (${optionsStrings})`: "";

    return `[${answerString}] answers and [${additionalsString}] additionals with size ${this.getEncodingLength()}B${optionsString}`;
  }

}
