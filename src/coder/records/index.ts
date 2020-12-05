import { RType } from "../DNSPacket";
import { ResourceRecord } from "../ResourceRecord";
import { AAAARecord } from "./AAAARecord";
import { ARecord } from "./ARecord";
import { CNAMERecord } from "./CNAMERecord";
import { NSECRecord } from "./NSECRecord";
import { OPTRecord } from "./OPTRecord";
import { PTRRecord } from "./PTRRecord";
import { SRVRecord } from "./SRVRecord";
import { TXTRecord } from "./TXTRecord";

ResourceRecord.typeToRecordDecoder.set(RType.AAAA, AAAARecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.A, ARecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.CNAME, CNAMERecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.NSEC, NSECRecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.PTR, PTRRecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.SRV, SRVRecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.OPT, OPTRecord.decodeData);
ResourceRecord.typeToRecordDecoder.set(RType.TXT, TXTRecord.decodeData);
