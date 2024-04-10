import assert from "assert";
import { DecodedData } from "./DNSPacket";

interface WrittenName {
  name: string;
  writtenLabels: number[]; // array of indices where the corresponding labels are written in the buffer
}

interface NameLength {
  name: string;
  length: number; // full length in bytes needed to encode this name
  labelLengths: number[]; // array of byte lengths for every individual label. will always end with root label with length of 1
}

export class DNSLabelCoder {

  static DISABLE_COMPRESSION = false;

  // RFC 1035 4.1.4. Message compression:
  //  In order to reduce the size of messages, the domain system utilizes a
  //   compression scheme which eliminates the repetition of domain names in a
  //   message.  In this scheme, an entire domain name or a list of labels at
  //   the end of a domain name is replaced with a pointer to a PRIOR occurrence
  //   of the same name.
  //
  //  The compression scheme allows a domain name in a message to be
  //  represented as either:
  //    - a sequence of labels ending in a zero octet
  //    - a pointer
  //    - a sequence of labels ending with a pointer

  // RFC 6762 name compression for rdata should be used in: NS, CNAME, PTR, DNAME, SOA, MX, AFSDB, RT, KX, RP, PX, SRV, NSEC

  private static readonly POINTER_MASK = 0xC000; // 2 bytes, starting with 11
  private static readonly POINTER_MASK_ONE_BYTE = 0xC0; // same deal as above, just on a 1 byte level
  private static readonly LOCAL_COMPRESSION_ONE_BYTE = 0x80; // "10" label type https://tools.ietf.org/html/draft-ietf-dnsind-local-compression-05#section-4
  private static readonly EXTENDED_LABEL_TYPE_ONE_BYTE = 0x40; // "01" edns extended label type https://tools.ietf.org/html/rfc6891#section-4.2
  private static readonly NOT_POINTER_MASK = 0x3FFF;
  private static readonly NOT_POINTER_MASK_ONE_BYTE = 0x3F;

  private buffer?: Buffer;
  readonly legacyUnicastEncoding: boolean;
  private startOfRR?: number;
  private startOfRData?: number;
  private rDataLength?: number;

  private readonly trackedLengths: NameLength[] = [];
  private readonly writtenNames: WrittenName[] = [];

  constructor(legacyUnicastEncoding?: boolean) {
    this.legacyUnicastEncoding = legacyUnicastEncoding || false;
  }

  public initBuf(buffer?: Buffer): void {
    this.buffer = buffer;
  }

  public initRRLocation(recordOffset: number, rDataOffset: number, rDataLength: number): void {
    this.startOfRR = recordOffset;
    this.startOfRData = rDataOffset;
    this.rDataLength = rDataLength;
  }

  public clearRRLocation(): void {
    this.startOfRR = undefined;
    this.startOfRData = undefined;
    this.rDataLength = undefined;
  }

  public getUncompressedNameLength(name: string): number {
    if (name === ".") {
      return 1; // root label takes one zero byte
    }
    assert(name.endsWith("."), "Supplied illegal name which doesn't end with the root label!");

    let length = 0;
    const labels: string[] = name.split(".");

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!label && i < labels.length - 1) {
        assert.fail("Label " + i  + " in name '" + name + "' was empty");
      }

      length += DNSLabelCoder.getLabelLength(label);
    }

    return length;
  }

  public getNameLength(name: string): number {
    if (DNSLabelCoder.DISABLE_COMPRESSION) {
      return this.getUncompressedNameLength(name);
    }

    if (name === ".") {
      return 1; // root label takes one zero byte and is not compressible
    }
    assert(name.endsWith("."), "Supplied illegal name which doesn't end with the root label!");

    const labelLengths: number[] = name.split(".")
      .map(label => DNSLabelCoder.getLabelLength(label));

    const nameLength: NameLength = {
      name: name,
      length: 0, // total length needed for encoding (with compression enabled)
      labelLengths: labelLengths,
    };

    let candidateSharingLongestSuffix: NameLength | undefined = undefined;
    let longestSuffixLength = 0; // amount of labels which are identical

    // pointers MUST only point to PRIOR label locations
    for (let i = 0; i < this.trackedLengths.length; i++) {
      const element = this.trackedLengths[i];
      const suffixLength = DNSLabelCoder.computeLabelSuffixLength(element.name, name);

      // it is very important that this is an GREATER and not just a GREATER EQUAL!!!!
      // don't change anything unless you fully understand all implications (0, and big comment block below)
      if (suffixLength > longestSuffixLength) {
        candidateSharingLongestSuffix = element;
        longestSuffixLength = suffixLength;
      }
    }

    let length = 0;
    if (candidateSharingLongestSuffix) {
      // in theory, it is possible that the candidate has a pointer which "fromIndex" is smaller than
      // the "toIndex" we are pointing to below. This could result in that we point to a location which
      // never gets written into the buffer, thus we can't point to it.
      // But as we always start in order (with the first element in our array; see for loop above)
      // we will always find the label first, which such a theoretical candidate is also pointing at

      const pointingFromIndex = labelLengths.length - 1 - longestSuffixLength; // -1 as the empty root label is always included

      for (let i = 0; i < pointingFromIndex; i++) {
        length += labelLengths[i];
      }
      length += 2; // 2 byte for the pointer
    } else {
      for (let i = 0; i < labelLengths.length; i++) {
        length += labelLengths[i];
      }
    }

    nameLength.length = length;
    this.trackedLengths.push(nameLength);

    return nameLength.length;
  }

  public encodeUncompressedName(name: string, offset: number): number {
    if (!this.buffer) {
      assert.fail("Illegal state. Buffer not initialized!");
    }

    return DNSLabelCoder.encodeUncompressedName(name, this.buffer, offset);
  }

  public static encodeUncompressedName(name: string, buffer: Buffer, offset: number): number {
    assert(name.endsWith("."), "Name does not end with the root label");
    const oldOffset = offset;

    const labels = name === "."
      ? [""]
      : name.split(".");

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];

      if (label === "") {
        assert(i === labels.length - 1, "Encountered root label being not at the end of the domain name");

        buffer.writeUInt8(0, offset++); // write a terminating zero
        break;
      }

      // write length byte followed by the label data
      const length = buffer.write(label, offset + 1);
      buffer.writeUInt8(length, offset);
      offset += length + 1;
    }

    return offset - oldOffset; // written bytes
  }

  public encodeName(name: string, offset: number): number {
    if (DNSLabelCoder.DISABLE_COMPRESSION) {
      return this.encodeUncompressedName(name, offset);
    }

    if (!this.buffer) {
      assert.fail("Illegal state. Buffer not initialized!");
    }

    if (name === ".") {
      this.buffer.writeUInt8(0, offset); // write a terminating zero
      return 1;
    }

    const oldOffset = offset;

    const labels: string[] = name.split(".");
    const writtenName: WrittenName = {
      name: name,
      writtenLabels: new Array(labels.length).fill(-1), // init with "-1" meaning unknown location
    };

    let candidateSharingLongestSuffix: WrittenName | undefined = undefined;
    let longestSuffixLength = 0; // amount of labels which are identical

    for (let i = 0; i < this.writtenNames.length; i++) {
      const element = this.writtenNames[i];
      const suffixLength = DNSLabelCoder.computeLabelSuffixLength(element.name, name);

      // it is very important that this is an GREATER and not just a GREATER EQUAL!!!!
      // don't change anything unless you fully understand all implications (0, and big comment block below)
      if (suffixLength > longestSuffixLength) {
        candidateSharingLongestSuffix = element;
        longestSuffixLength = suffixLength;
      }
    }

    if (candidateSharingLongestSuffix) {
      // in theory, it is possible that the candidate has a pointer which "fromIndex" is smaller than
      // the "toIndex" we are pointing to below. This could result in that we point to a location which
      // never gets written into the buffer, thus we can't point to it.
      // But as we always start in order (with the first element in our array; see for loop above)
      // we will always find the label first, which such a theoretical candidate is also pointing at

      const pointingFromIndex = labels.length - 1 - longestSuffixLength; // -1 as the empty root label is always included
      const pointingToIndex = candidateSharingLongestSuffix.writtenLabels.length - 1 - longestSuffixLength;

      for (let i = 0; i < pointingFromIndex; i++) {
        writtenName.writtenLabels[i] = offset;
        offset += DNSLabelCoder.writeLabel(labels[i], this.buffer, offset);
      }

      const pointerDestination = candidateSharingLongestSuffix.writtenLabels[pointingToIndex];
      assert(pointerDestination !== -1, "Label which was pointed at wasn't yet written to the buffer!");
      assert(pointerDestination <= DNSLabelCoder.NOT_POINTER_MASK, "Pointer exceeds to length of a maximum of 14 bits");
      assert(pointerDestination < offset, "Pointer can only point to a prior location");

      const pointer = DNSLabelCoder.POINTER_MASK | pointerDestination;
      this.buffer.writeUInt16BE(pointer, offset);
      offset += 2;
    } else {
      for (let i = 0; i < labels.length; i++) {
        writtenName.writtenLabels[i] = offset;
        offset += DNSLabelCoder.writeLabel(labels[i], this.buffer, offset);
      }
    }

    this.writtenNames.push(writtenName);

    return offset - oldOffset; // written bytes
  }

  public decodeName(offset: number, resolvePointers = true): DecodedData<string> {
    if (!this.buffer) {
      assert.fail("Illegal state. Buffer not initialized!");
    }

    const oldOffset = offset;

    let name = "";

    for (;;) {
      const length: number = this.buffer.readUInt8(offset++);
      if (length === 0) { // zero byte to terminate the name
        name += ".";
        break; // root label marks end of name
      }

      const labelTypePattern: number = length & DNSLabelCoder.POINTER_MASK_ONE_BYTE;
      if (labelTypePattern) {
        if (labelTypePattern === DNSLabelCoder.POINTER_MASK_ONE_BYTE) {
          // we got a pointer here
          const pointer = this.buffer.readUInt16BE(offset - 1) & DNSLabelCoder.NOT_POINTER_MASK; // extract the offset
          offset++; // increment for the second byte of the pointer

          if (!resolvePointers) {
            name += name? ".~": "~";
            break;
          }

          // if we would allow pointers to a later location, we MUST ensure that we don't end up in an endless loop
          assert(pointer < oldOffset, "Pointer at " + (offset - 2) + " MUST point to a prior location!");

          name += (name? ".": "") + this.decodeName(pointer).data; // recursively decode the rest of the name
          break; // pointer marks end of name
        }  else if (labelTypePattern === DNSLabelCoder.LOCAL_COMPRESSION_ONE_BYTE) {
          let localPointer = this.buffer.readUInt16BE(offset - 1) & DNSLabelCoder.NOT_POINTER_MASK;
          offset++; // increment for the second byte of the pointer;

          if (!resolvePointers) {
            name += name? ".~": "~";
            break;
          }

          if (localPointer >= 0 && localPointer < 255) { // 255 is reserved
            assert(this.startOfRR !== undefined, "Cannot decompress locally compressed name as record is not initialized!");
            localPointer += this.startOfRR!;

            assert(localPointer < oldOffset, "LocalPointer <255 at " + (offset - 2) + " MUST point to a prior location!");

            name += (name? ".": "") + this.decodeName(localPointer).data; // recursively decode the rest of the name
          } else if (localPointer >= 256) {
            assert(this.startOfRData !== undefined && this.rDataLength !== undefined, "Cannot decompress locally compressed name as record is not initialized!");
            localPointer -= -256; // subtract the offset 256

            localPointer += this.startOfRData!;

            assert(localPointer < oldOffset, "LocationPoint >265 at " + (offset + 2) + " MUST point to a prior location!");

            name += (name? ".": "") + this.decodeName(localPointer).data; // recursively decode the rest of the name
          } else {
            assert.fail("Encountered unknown pointer range " + localPointer);
          }

          break; // pointer marks end of name
        } else if (labelTypePattern === DNSLabelCoder.EXTENDED_LABEL_TYPE_ONE_BYTE) {
          const extendedLabelType = length & DNSLabelCoder.NOT_POINTER_MASK_ONE_BYTE;

          assert.fail("Received extended label type " + extendedLabelType + " at " + (offset - 1));
        } else {
          assert.fail("Encountered unknown pointer type: " + Buffer.from([labelTypePattern >> 6]).toString("hex") + " (with original byte " +
            Buffer.from([length]).toString("hex") + ")");
        }
      }

      const label = this.buffer.toString("utf-8", offset, offset + length);
      offset += length;

      name += (name? ".": "") + label;
    }

    return {
      data: name,
      readBytes: offset - oldOffset,
    };
  }

  private static getLabelLength(label: string): number {
    if (!label) { // empty label aka root label
      return 1; // root label takes one zero byte
    } else {
      const byteLength = Buffer.byteLength(label);
      assert(byteLength <= 63, "Label cannot be longer than 63 bytes (" + label + ")");
      return 1 + byteLength; // length byte + label data
    }
  }

  private static writeLabel(label: string, buffer: Buffer, offset: number): number {
    if (!label) {
      buffer.writeUInt8(0, offset);
      return 1;
    } else {
      const length = buffer.write(label, offset + 1);
      buffer.writeUInt8(length, offset);

      return length + 1;
    }
  }

  private static computeLabelSuffixLength(a: string, b: string): number {
    assert(a.length !== 0 && b.length !== 0, "Encountered empty name when comparing suffixes!");
    const lastAIndex = a.length - 1;
    const lastBIndex = b.length - 1;

    let equalLabels = 0;
    let exitByBreak = false;

    // we start with i=1 as the last character will always be the root label terminator "."
    for (let i = 1; i <= lastAIndex && i <= lastBIndex; i++) {
      // we are comparing both strings backwards
      const aChar = a.charAt(lastAIndex - i);
      const bChar = b.charAt(lastBIndex - i);
      assert(!!aChar && !!bChar, "Seemingly encountered out of bounds trying to calculate suffixes");

      if (aChar !== bChar) {
        exitByBreak = true;
        break; // encountered the first character to differ
      } else if (aChar === ".") {
        // we reached the label terminator, thus we count up the labels which are equal
        equalLabels++;
      }
    }

    if (!exitByBreak) {
      equalLabels++; // accommodate for the top level label (fqdn doesn't start with a dot)
    }

    return equalLabels;
  }

}

export class NonCompressionLabelCoder extends DNSLabelCoder {

  public static readonly INSTANCE = new NonCompressionLabelCoder();

  public getNameLength(name: string): number {
    return this.getUncompressedNameLength(name);
  }

  public encodeName(name: string, offset: number): number {
    return this.encodeUncompressedName(name, offset);
  }

}
