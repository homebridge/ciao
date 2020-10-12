import { QType, RType } from "./DNSPacket";

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
    case 41:
      return "OPT";
    case 47:
      return "NSEC";
    case 255:
      return "ANY";
  }
  return "UNSUPPORTED_" + type;
}
