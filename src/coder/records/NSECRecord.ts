import assert from "assert";
import deepEqual from "fast-deep-equal";
import { DNSLabelCoder } from "../DNSLabelCoder";
import { DecodedData, RType } from "../DNSPacket";
import { RecordRepresentation, ResourceRecord } from "../ResourceRecord";

interface RRTypeWindow {
  windowId: number;
  bitMapSize: number;
  rrtypes: RType[];
}

export class NSECRecord extends ResourceRecord {

  readonly nextDomainName: string;
  readonly rrTypeWindows: RRTypeWindow[];

  constructor(name: string, nextDomainName: string, rrtypes: RType[], ttl: number, flushFlag?: boolean);
  constructor(header: RecordRepresentation, nextDomainName: string, rrtypes: RType[]);
  constructor(name: string | RecordRepresentation, nextDomainName: string, rrtypes: RType[], ttl?: number, flushFlag?: boolean) {
    if (typeof name === "string") {
      super(name, RType.NSEC, ttl || 120, flushFlag);
    } else {
      assert(name.type === RType.NSEC);
      super(name);
    }

    if (!nextDomainName.endsWith(".")) {
      nextDomainName += ".";
    }

    this.nextDomainName = nextDomainName;
    this.rrTypeWindows = NSECRecord.rrTypesToWindowMap(rrtypes);
  }

  private getRRTypesBitMapEncodingLength(): number {
    let rrTypesBitMapLength = 0;

    for (const window of this.rrTypeWindows) {
      assert(window.rrtypes.length > 0, "types array for windowId " + window.windowId + " cannot be empty!");

      rrTypesBitMapLength += 2 // 1 byte for windowId; 1 byte for bitmap length
        + window.bitMapSize;
    }

    return rrTypesBitMapLength;
  }

  protected getRDataEncodingLength(coder: DNSLabelCoder): number {
    // RFC 4034 4.1.1. name compression MUST NOT be used for the nextDomainName, though RFC 6762 18.14 specifies it should
    return coder.getNameLength(this.nextDomainName)
      + this.getRRTypesBitMapEncodingLength();
  }

  protected encodeRData(coder: DNSLabelCoder, buffer: Buffer, offset: number): number {
    const oldOffset = offset;

    const length = coder.encodeName(this.nextDomainName, offset);
    offset += length;

    // RFC 4034 4.1.2. type bit maps field has the following format ( Window Block # | Bitmap Length | Bitmap )+ (with | concatenation)
    // e.g. 0x00 0x01 0x40 => defines the window 0; bitmap length 1; and the bitmap 10000000, meaning the first bit is
    // set for the 0th window => rrTypes = [A]. The bitmap length depends on the rtype with the highest value for the
    // given value (max 32 bytes per bitmap)
    for (const window of this.rrTypeWindows) {
      buffer.writeUInt8(window.windowId, offset++);
      buffer.writeUInt8(window.bitMapSize, offset++);

      const bitmap = Buffer.alloc(window.bitMapSize);
      for (const type of window.rrtypes) {
        const byteNum =  (type & 0xFF) >> 3; // basically floored division by 8

        let mask = bitmap.readUInt8(byteNum);
        mask |= 1 << (7 - (type & 0x7)); // OR with 1 shifted according to the lowest 3 bits

        bitmap.writeUInt8(mask, byteNum);
      }

      bitmap.copy(buffer, offset);
      offset += bitmap.length;
    }

    return offset - oldOffset;
  }

  public static decodeData(coder: DNSLabelCoder, header: RecordRepresentation, buffer: Buffer, offset: number): DecodedData<NSECRecord> {
    const oldOffset = offset;

    /**
     * Quick note to the line below. We base "false" as the second argument to decodeName, telling
     * it to not resolve pointers.
     * We discovered that especially UniFi routers with a VLAN setup and mdns forwarding enabled,
     * fail to properly encode pointers inside the nextDomainName field.
     * Those pointers simply point to random points in the record data, resulting in decoding to fail.
     * As the field doesn't have any meaning and we simply don't use it, we just skip decoding for now.
     */
    const decodedNextDomainName = coder.decodeName(offset, false);
    offset += decodedNextDomainName.readBytes;

    const rrTypes: RType[] = [];
    while (offset < buffer.length) {
      const windowId = buffer.readUInt8(offset++);
      const bitMapLength = buffer.readUInt8(offset++);

      const upperRType = windowId << 8;

      for (let block = 0; block < bitMapLength; block++) {
        const byte = buffer.readUInt8(offset++);

        for (let bit = 0; bit < 8; bit++) { // iterate over every bit
          if (byte & (1 << (7 - bit))) { // check if bit is set
            const rType = upperRType | (block << 3) | bit; // OR upperWindowNum | basically block * 8 | bit number
            rrTypes.push(rType);
          }
        }
      }
    }

    return {
      data: new NSECRecord(header, decodedNextDomainName.data, rrTypes),
      readBytes: offset - oldOffset,
    };
  }

  public clone(): NSECRecord {
    return new NSECRecord(this.getRecordRepresentation(), this.nextDomainName, NSECRecord.windowsToRRTypes(this.rrTypeWindows));
  }

  public dataAsString(): string {
    return `${this.nextDomainName} [${NSECRecord.windowsToRRTypes(this.rrTypeWindows).map(rtype => ""+rtype).join(",")}]`;
  }

  public dataEquals(record: NSECRecord): boolean {
    return this.nextDomainName === record.nextDomainName && deepEqual(this.rrTypeWindows, record.rrTypeWindows);
  }

  private static rrTypesToWindowMap(rrtypes: RType[]): RRTypeWindow[] {
    const rrTypeWindows: RRTypeWindow[] = [];

    for (const rrtype of rrtypes) {
      const windowId = rrtype >> 8;

      let window: RRTypeWindow | undefined = undefined;
      for (const window0 of rrTypeWindows) {
        if (window0.windowId === windowId) {
          window = window0;
          break;
        }
      }

      if (!window) {
        window = {
          windowId: windowId,
          bitMapSize: Math.ceil((rrtype & 0xFF) / 8),
          rrtypes: [rrtype],
        };
        rrTypeWindows.push(window);
      } else {
        window.rrtypes.push(rrtype);

        const bitMapSize = Math.ceil((rrtype & 0xFF) / 8);
        if (bitMapSize > window.bitMapSize) {
          window.bitMapSize = bitMapSize;
        }
      }
    }

    // sort by windowId
    rrTypeWindows.sort((a, b) => a.windowId - b.windowId);
    rrTypeWindows.forEach(window => window.rrtypes.sort((a, b) => a - b));

    return rrTypeWindows;
  }

  private static windowsToRRTypes(windows: RRTypeWindow[]): RType[] {
    const rrtypes: RType[] = [];

    for (const window of windows) {
      rrtypes.push(...window.rrtypes);
    }

    return rrtypes;
  }

}
