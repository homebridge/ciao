import assert from "assert";
import { DecodedData } from "./DNSPacket";

export interface Label {
  label: string;
  writtenAt: number; // is initialized with -1 when location is unknown
}

export interface Pointer {
  fromIndex: number; // defines the index where the pointer must be inserted in the SOURCE
  toName: Name; // defines the DESTINATION name object
  atPosition: number; // defines the offset in the DESTINATION
}

export interface Name {
  fullName: string;
  labels: Label[];
  pointer?: Pointer;
}

export class DNSLabelCoder {

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
  private static readonly NOT_POINTER_MASK = 0x3FFF;

  private buffer?: Buffer;
  private readonly writtenNames: Name[] = [];

  private readonly trackedNames: Name[] = [];
  private computedCompressionPaths = false;

  public initBuf(buffer: Buffer): void {
    this.buffer = buffer;
  }

  public trackName(name: string): Name {
    assert(name.endsWith("."), "Name does not end with the root label");

    this.invalidateCompressionPaths(); // adding a new label. invalidates all previous compression paths

    const nameObject: Name = DNSLabelCoder.allocNameObject(name);

    this.trackedNames.push(nameObject);

    return nameObject;
  }

  protected static allocNameObject(name: string): Name {
    return {
      fullName: name,
      labels: name === "."
        ? [{
          label: "",
          writtenAt: -1,
        }]
        : name.split(".").map(label => ({
          label: label,
          writtenAt: -1,
        })),
    };
  }

  private invalidateCompressionPaths(): void {
    if (this.computedCompressionPaths) {
      this.computedCompressionPaths = false;
      this.trackedNames.forEach(name => name.pointer = undefined); // invalidate all computed pointers
    }
  }

  public computeCompressionPaths(): void {
    if (this.computedCompressionPaths) {
      return; // nothing was changed, no need to recompute the same result
    }

    // i can start at 1, as the first element has no predecessors
    for (let i = 1; i < this.trackedNames.length; i++) {
      const element = this.trackedNames[i];

      let candidateSharingLongestSuffix: Name | undefined = undefined;
      let longestSuffixLength = 0; // amount of labels which are identical

      for (let j = 0; j < i; j++) { // pointers can only point to PRIOR label locations
        const candidate = this.trackedNames[j];

        const suffixLength = DNSLabelCoder.computeLabelSuffixLength(element, candidate);

        // it is very important that this is an GREATER and not just a GREATER EQUAL!!!!
        // don't change anything unless you fully understand all implications (0, and big comment block below)
        if (suffixLength > longestSuffixLength) {
          candidateSharingLongestSuffix = candidate;
          longestSuffixLength = suffixLength;
        }
      }

      if (candidateSharingLongestSuffix) {
        // in theory it is possible that the candidate has an pointer which "fromIndex" is smaller than the
        // the "atPosition" we are pointing to below. This could result in that we point to a location which
        // never gets written into the buffer, thus we can't point to it.
        // But as we always start in order (with the first element in our array; see for loop above)
        // we will always find the label first, which such a theoretical candidate is also pointing at

        element.pointer = {
          fromIndex: element.labels.length - longestSuffixLength - 1, // -1 as the empty root label is always included
          toName: candidateSharingLongestSuffix,
          atPosition: candidateSharingLongestSuffix.labels.length - longestSuffixLength - 1,
        };
      }
    }
  }

  public getNameLength(name: Name): number; // returns how much the name will take in an possibly compressed way
  public getNameLength(name: string): number // returns the length for an uncompressed name
  public getNameLength(name: Name | string): number {
    let labels: string[];
    let maxI: number;

    let length = 0;

    if (typeof name === "string") {
      assert(name.endsWith("."), "Name does not end with the root label");

      labels = name === "."? [""]: name.split(".");
      maxI = labels.length;
    } else {
      assert(this.trackedNames.includes(name), "Encountered name in encoding we don't know about yet!");
      labels = name.labels.map(label => label.label);

      if (name.pointer) {
        maxI = name.pointer.fromIndex;
        length += 2; // already add the 2 byte pointer length which will be appended
      } else {
        maxI = name.labels.length;
      }
    }

    for (let i = 0; i < maxI; i++) {
      const label = labels[i];

      if (!label) { // empty label aka root label
        if (i < labels.length - 1) { // check that the empty label can only be the root label
          assert.fail("Label " + i  + " in name " + name + " was empty");
        }

        length++; // root label takes one zero byte
      } else {
        const byteLength = Buffer.byteLength(label);
        assert(byteLength <= 63, "Label cannot be longer than 63 bytes (" + label + ")");
        length += 1 + byteLength; // length byte + label data
      }
    }

    return length;
  }

  public encodeName(name: Name, offset: number): number; // encodes the name in an possibly compressed format
  public encodeName(name: string, offset: number): number; // encodes the name in uncompressed format
  public encodeName(name: Name | string, offset: number): number {
    if (!this.buffer) {
      assert.fail("Illegal state. Buffer not initialized!");
    }
    const oldOffset = offset;

    if (typeof name === "string") {
      assert(name.endsWith("."), "Name does not end with the root label");
      assert(name !== ".", "the name must be more than just the root label.");

      const labels = name.split(".");

      for (let i = 0; i < labels.length; i++) {
        const label = labels[i];

        if (label === "") {
          assert(i === labels.length - 1, "Encountered root label being not at the end of the domain name");

          this.buffer.writeUInt8(0, offset++); // write a terminating zero
          break;
        }

        // write length byte followed by the label data
        const length = this.buffer.write(label, offset + 1);
        this.buffer.writeUInt8(length, offset);
        offset += length + 1;
      }
    } else {
      assert(this.trackedNames.includes(name), "Encountered name in encoding we don't know about yet!");
      const maxI = name.pointer ? name.pointer.fromIndex : name.labels.length;

      for (let i = 0; i < maxI; i++) {
        const label = name.labels[i];

        if (label.label === "") {
          assert(i === name.labels.length - 1, "Encountered root label being not at the end of the domain name");

          this.buffer.writeUInt8(0, offset); // write a terminating zero
          label.writtenAt = offset++;
          break;
        }

        // write length byte followed by the label data
        const length = this.buffer.write(label.label, offset + 1);
        this.buffer.writeUInt8(length, offset);

        label.writtenAt = offset;
        offset += length + 1;
      }

      if (name.pointer) {
        const pointed = name.pointer.toName.labels[name.pointer.atPosition];
        assert(pointed, "Could not find label which pointer points at");
        assert(pointed.writtenAt !== -1, "Label which was pointed at wasn't yet written to the buffer!");
        assert(pointed.writtenAt <= DNSLabelCoder.NOT_POINTER_MASK, "Pointer exceeds to length of a maximum of 14 bits");
        assert(pointed.writtenAt < offset, "Pointer can only point to a prior location");

        const pointer = DNSLabelCoder.POINTER_MASK | pointed.writtenAt;

        this.buffer.writeUInt16BE(pointer, offset);
        offset += 2;
      }
    }

    return offset - oldOffset; // written bytes
  }

  public resetCoder(): void {
    if (!this.buffer) {
      assert.fail("Illegal state. Buffer not initialized!");
    }

    // reset the label coder
    this.buffer = undefined;
    this.trackedNames.splice(0, this.trackedNames.length);
    this.computedCompressionPaths = false;
  }

  public decodeName(offset: number): DecodedData<string> {
    if (!this.buffer) {
      assert.fail("Illegal state. Buffer not initialized!");
    }

    const oldOffset = offset;

    let name = "";

    for (;;) {
      const length = this.buffer.readUInt8(offset++);
      if (length === 0) { // zero byte to terminate the name
        name += ".";
        break; // root label marks end of name
      }

      if ((length & DNSLabelCoder.POINTER_MASK_ONE_BYTE) === DNSLabelCoder.POINTER_MASK_ONE_BYTE) {
        // we got a pointer here
        const pointer = this.buffer.readUInt16BE(offset - 1) & DNSLabelCoder.NOT_POINTER_MASK; // extract the offset
        offset++; // increment for the second byte of the pointer

        name += (name? ".": "") + this.decodeName(pointer).data; // recursively decode the rest of the name
        break; // pointer marks end of name
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

  public static getUncompressedNameLength(name: string): number {
    return NonCompressionLabelCoder.INSTANCE.getNameLength(name);
  }

  private static nameComparator(a: Name, b: Name): number {
    if (a.fullName.length !== b.fullName.length) {
      return b.fullName.length - a.fullName.length; // sorting length descending
    }
    return a.fullName.localeCompare(b.fullName); // sort by lexicographical order for deterministic results
  }

  private static computeLabelSuffixLength(element: Name, candidate: Name): number {
    assert(element.fullName.endsWith(".") && candidate.fullName.endsWith("."), "Encountered illegal domain names!");
    const lastAIndex = element.fullName.length - 1;
    const lastBIndex = candidate.fullName.length - 1;
    assert(lastAIndex >= 0 && lastBIndex >= 0, "Encountered empty name when comparing suffixes!");

    let equalLabels = 0;
    let exitByBreak = false;

    // we start with i=1 as the last character will always be the root label terminator "."
    for (let i = 1; i <= lastAIndex && i <= lastBIndex; i++) {
      // we are comparing both strings backwards
      const aChar = element.fullName.charAt(lastAIndex - i);
      const bChar = candidate.fullName.charAt(lastBIndex - i);
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
      equalLabels++;
    }

    return equalLabels;
  }

}

export class NonCompressionLabelCoder extends DNSLabelCoder {

  public static readonly INSTANCE = new NonCompressionLabelCoder();


  trackName(name: string): Name {
    return DNSLabelCoder.allocNameObject(name); // prevent adding to the dict
  }

  computeCompressionPaths(): void {
    // empty
  }

  getNameLength(name: Name | string): number {
    if (typeof name === "string") {
      return super.getNameLength(name);
    } else {
      return super.getNameLength(name.fullName); // disable compression
    }
  }

  encodeName(name: Name | string, offset: number): number {
    if (typeof name === "string") {
      return super.encodeName(name, offset);
    } else {
      return super.encodeName(name.fullName, offset); // disable compression
    }
  }
}
