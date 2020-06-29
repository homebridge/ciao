import assert from "assert";
import { IPFamily, MDNSServer } from "../index";
import { DNSLabelCoder, NonCompressionLabelCoder } from "./DNSLabelCoder";
import { Question } from "./Question";
import { SRVRecord } from "./records/SRVRecord";
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
  NSEC = 47, // RFC 4034 4.
  // TODO implement decoding 41 OPT
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

  trackNames(coder: DNSLabelCoder): void;

  getEncodingLength(coder: DNSLabelCoder): number;

  encode(coder: DNSLabelCoder, buffer: Buffer, offset: number): number;

}

export class DNSPacket {

  private static readonly AUTHORITATIVE_ANSWER_MASK = 0x400;
  private static readonly TRUNCATION_MASK = 0x200;
  private static readonly RECURSION_DESIRED_MASK = 0x100;
  private static readonly RECURSION_AVAILABLE_MASK = 0x80;
  private static readonly ZERO_HEADER_MASK = 0x40;
  private static readonly AUTHENTIC_DATA_MASK = 0x20;
  private static readonly CHECKING_DISABLED_MASK = 0x10;

  // 2 bytes ID, 2 bytes flags, 2 bytes question count, 2 bytes answer count, 2 bytes authorities count; 2 bytes additionals count
  private static readonly DNS_PACKET_HEADER_SIZE = 12;

  readonly id: number;

  readonly type: PacketType;
  readonly opcode: OpCode;
  readonly flags: PacketFlags;
  readonly rcode: RCode;

  readonly questions: Question[];
  readonly answers: ResourceRecord[];
  readonly authorities: ResourceRecord[];
  readonly additionals: ResourceRecord[];

  private readonly labelCoder: DNSLabelCoder;
  private estimatedPacketSize = 0; // only set in encoding mode

  private constructor(definition: PacketDefinition, encode = true) {
    this.id = definition.id || 0;

    this.type = definition.type;
    this.opcode = definition.opcode || OpCode.QUERY;
    this.flags = definition.flags || {};
    this.rcode = definition.rCode || RCode.NoError;

    this.questions = definition.questions || [];
    this.answers = definition.answers || [];
    this.authorities = definition.authorities || [];
    this.additionals = definition.additionals || [];

    this.labelCoder = new DNSLabelCoder();

    if (encode) {
      this.initialNameTracking();
    }
  }

  public static createDNSQueryPackets(definition: DNSQueryDefinition | DNSProbeQueryDefinition, mtu: number, ipFamily = IPFamily.IPv4): DNSPacket[] {
    // subtracting space needed for the ip and udp header
    mtu -= (ipFamily === IPFamily.IPv4? MDNSServer.DEFAULT_IP4_HEADER: MDNSServer.DEFAULT_IP6_HEADER) + MDNSServer.UDP_HEADER;

    const packets: DNSPacket[] = [];

    // packet is like the "main" packet
    const packet = new DNSPacket({
      type: PacketType.QUERY,
      questions: definition.questions,
    });
    packets.push(packet);

    if (packet.getEstimatedEncodingLength() > mtu) {
      const compressedLength = packet.getEncodingLength(); // calculating the real length will update the estimated property as well
      if (compressedLength > mtu) {
        // if we are still above the MTU we have a problem
        assert.fail("Cannot send query where already the query section is exceeding the mtu (" + compressedLength + ">" + mtu +")!");
      }
    }

    if (isQuery(definition) && definition.answers) {
      let i = 0;
      let currentPacket = packet;

      // in the loop below, we check if we need to truncate the list of known-answers in the query

      while (i < definition.answers.length) {
        for (; i < definition.answers.length; i++) {
          const answer = definition.answers[i];
          const estimatedSize = answer.getEstimatedEncodingLength();

          // TODO we should check if it fits in any of the previous packets

          if (packet.getEstimatedEncodingLength() + estimatedSize <= mtu) { // size check on estimated calculations
            currentPacket.addAnswers(answer);
          } else if (packet.getEncodingLength() + estimatedSize <= mtu) { // size check using message compression
            // TODO can we somehow count the compressed encoding length of the new packet
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

        if (i < definition.answers.length) { // if there are more records left, we need to truncate the packet again
          currentPacket.flags.truncation = true; // first of all, mark the previous packet as truncated
          currentPacket = new DNSPacket({ type: PacketType.QUERY });
          packets.push(currentPacket);
        }
      }
    } else if (isProbeQuery(definition) && definition.authorities) {
      packet.addAuthorities(...definition.authorities);
      const compressedLength = packet.getEncodingLength();

      if (compressedLength > mtu) {
        // TODO maybe a warning is enough?
        assert.fail("Probe query packet exceeds the mtu size (" + compressedLength + ">" + mtu + ")");
      }
    } // otherwise, the packet consist of only questions

    return packets;
  }

  public static createDNSResponsePackets(definition: DNSResponseDefinition, mtu: number, ipFamily = IPFamily.IPv4): DNSPacket[] {
    // subtracting space needed for the ip and udp header
    mtu -= (ipFamily === IPFamily.IPv4? MDNSServer.DEFAULT_IP4_HEADER: MDNSServer.DEFAULT_IP6_HEADER) + MDNSServer.UDP_HEADER;

    const packets: DNSPacket[] = [];

    const packet = new DNSPacket({
      type: PacketType.RESPONSE,
      flags: { authoritativeAnswer: true }, // RFC 6763 18.4 AA is always set for responses in mdns
      // possible questions sent back to an unicast querier (unicast dns contain only one question, so no size problem here)
      questions: definition.questions,
    });
    packets.push(packet);

    // were trying to put as much answers as possible into the packet
    // we expect that the caller of the method will only call the method for records which relate to the same
    // service. If records from multiple services should be combined, it is advised to create a response packet
    // for every service and check if the packets are able to be combined.
    // TODO add method to check if two DNSPackets can be combined into one

    {
      // first of all we add as many answers possible, any other answers will be split on the next packet

      let i = 0; // answers index
      let currentPacket = packet;

      while (i < definition.answers.length) {
        for (; i < definition.answers.length; i++) {
          const answer = definition.answers[i];
          const estimatedSize = answer.getEstimatedEncodingLength();

          if (definition.legacyUnicast && answer instanceof SRVRecord) {
            // RFC 6762 18.14. In legacy unicast responses generated to answer legacy queries, name
            //    compression MUST NOT be performed on SRV records. (meaning compression inside the rData)
            answer.targetingLegacyUnicastQuerier = true;
          }

          // TODO we should check if it fits in any of the previous packets

          if (packet.getEstimatedEncodingLength() + estimatedSize <= mtu) { // size check on estimated calculations
            currentPacket.addAnswers(answer);
          } else if (packet.getEncodingLength() + estimatedSize <= mtu) { // size check using message compression
            // TODO can we somehow count the compressed encoding length of the new packet
            currentPacket.addAnswers(answer);
          } else {
            if (currentPacket.answers.length === 0 && !definition.legacyUnicast) {
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

        if (i < definition.answers.length) {
          // RFC 6762 18.5. In multicast response messages, the TC bit MUST be zero on
          //    transmission, and MUST be ignored on reception.

          currentPacket = new DNSPacket({
            type: PacketType.RESPONSE,
            flags: {authoritativeAnswer: true},
          });
          packets.push(currentPacket);

          if (definition.legacyUnicast) {
            // RFC 6762 18.5. In legacy unicast response messages, the TC bit has the same meaning
            //    as in conventional Unicast DNS: it means that the response was too
            //    large to fit in a single packet, so the querier SHOULD reissue its
            //    query using TCP in order to receive the larger response.

            // the rest of the packets simply won't be sent
            currentPacket.flags.truncation = true;
            break;
          }
        }
      }
    }

    if (definition.additionals) {
      // if there is still room we will add all additionals which still have room in the packet

      let j = 0; // additionals index
      const lastPacket = packets[packets.length - 1];

      for (; j < definition.additionals.length; j++) {
        const additional = definition.additionals[j];
        const estimatedSize = additional.getEstimatedEncodingLength();

        if (definition.legacyUnicast && additional instanceof SRVRecord) {
          // RFC 6762 18.14. In legacy unicast responses generated to answer legacy queries, name
          //    compression MUST NOT be performed on SRV records. (meaning compression inside the rData)
          additional.targetingLegacyUnicastQuerier = true;
        }

        // TODO we should check if it fits in any of the previous packets

        if (packet.getEstimatedEncodingLength() + estimatedSize <= mtu) { // size check on estimated calculations
          lastPacket.addAdditionals(additional);
        } else if (packet.getEncodingLength() + estimatedSize <= mtu) { // size check using message compression
          // TODO can we somehow count the compressed encoding length of the new packet
          lastPacket.addAdditionals(additional);
        } else {
          break;
        }
      }

      // the rest of the additionals are ignored, we are not sending packets only consisting of additionals
      // remember additionals SHOULD be included. The querier should simply send another query if it needs anything.
    }

    return packets;
  }

  private addAnswers(...answers: ResourceRecord[]): void {
    this.initialNameTracking();

    for (const record of answers) {
      record.trackNames(this.labelCoder);
      this.answers.push(record);

      this.estimatedPacketSize += record.getEstimatedEncodingLength();
    }
  }

  private addAuthorities(...authorities: ResourceRecord[]): void {
    this.initialNameTracking();

    for (const record of authorities) {
      record.trackNames(this.labelCoder);
      this.authorities.push(record);

      this.estimatedPacketSize += record.getEstimatedEncodingLength();
    }
  }

  private addAdditionals(...additionals: ResourceRecord[]): void {
    this.initialNameTracking();

    for (const record of additionals) {
      record.trackNames(this.labelCoder);
      this.additionals.push(record);

      this.estimatedPacketSize += record.getEstimatedEncodingLength();
    }
  }

  private initialNameTracking() {
    if (this.estimatedPacketSize > 0) {
      return;
    }

    this.questions.forEach(question => question.trackNames(this.labelCoder));
    this.answers.forEach(record => record.trackNames(this.labelCoder));
    this.authorities.forEach(record => record.trackNames(this.labelCoder));
    this.additionals.forEach(record => record.trackNames(this.labelCoder));

    this.estimatedPacketSize = DNSPacket.DNS_PACKET_HEADER_SIZE;

    this.questions.forEach(question => this.estimatedPacketSize += question.getEstimatedEncodingLength());
    this.answers.forEach(record => this.estimatedPacketSize += record.getEstimatedEncodingLength());
    this.authorities.forEach(record => this.estimatedPacketSize += record.getEstimatedEncodingLength());
    this.additionals.forEach(record => this.estimatedPacketSize += record.getEstimatedEncodingLength());
  }

  private getEstimatedEncodingLength(): number {
    return this.estimatedPacketSize; // returns the upper bound (<=) for the packet length
  }

  private getEncodingLength(): number {
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
    this.initialNameTracking();

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

    this.labelCoder.resetCoder(); // this call will write all pointers used for message compression and clean up the names array

    this.questions.forEach(record => record.finishEncoding());
    this.answers.forEach(record => record.finishEncoding());
    this.authorities.forEach(record => record.finishEncoding());
    this.additionals.forEach(record => record.finishEncoding());

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
    }, false);
  }

}
