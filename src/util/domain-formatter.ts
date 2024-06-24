import assert from "assert";
import net from "net";
import { ServiceType } from "../CiaoService";
import { Protocol } from "../index";

function isProtocol(part: string): boolean {
  return part === "_" + Protocol.TCP || part === "_" + Protocol.UDP;
}

function isSub(part: string): boolean {
  return part === "_sub";
}

function removePrefixedUnderscore(part: string): string {
  return part.startsWith("_")? part.slice(1): part;
}

export interface PTRQueryDomain { // like _http._tcp.local
  domain: string; // most of the time it is just local
  protocol: Protocol;
  type: ServiceType | string;
}

export interface InstanceNameDomain { // like "My Great Device._hap._tcp.local"; _services._dns-sd._udp.local is a special case of this type
  domain: string; // most of the time it is just "local"
  protocol: Protocol;
  type: ServiceType | string;
  name: string;
}

export interface SubTypedNameDomain { // like _printer._sub._http._tcp.local
  domain: string; // most of the time it is just local
  protocol: Protocol;
  type: ServiceType | string;
  subtype: ServiceType | string;
}

export interface FQDNParts {
  name?: string; // exclude if you want to build a PTR domain name
  type: ServiceType | string;
  protocol?: Protocol; // default tcp
  domain?: string; // default local
}

export interface SubTypePTRParts { // like '_printer._sub._http._tcp.local'
  subtype: ServiceType | string; // !!! ensure this name matches
  type: ServiceType | string; // the main type
  protocol?: Protocol; // default tcp
  domain?: string; // default local
}

function isSubTypePTRParts(parts: FQDNParts | SubTypePTRParts): parts is SubTypePTRParts {
  return "subtype" in parts;
}

export function parseFQDN(fqdn: string): PTRQueryDomain | InstanceNameDomain | SubTypedNameDomain {
  const parts = fqdn.split(".");

  assert(parts.length >= 3, "Received illegal fqdn: " + fqdn);

  let i = parts.length - 1;

  let domain = "";
  while (!isProtocol(parts[i])) {
    domain = removePrefixedUnderscore(parts[i]) + (domain? "." + domain: "");
    i--;
  }

  assert(i >= 1, "Failed to parse illegal fqdn: " + fqdn);

  const protocol = removePrefixedUnderscore(parts[i--]) as Protocol;
  const type = removePrefixedUnderscore(parts[i--]);

  if (i < 0) {
    return {
      domain: domain,
      protocol: protocol,
      type: type,
    };
  } else if (isSub(parts[i])) {
    i--; // skip "_sub";
    assert(i === 0, "Received illegal formatted sub type fqdn: " + fqdn);

    const subtype = removePrefixedUnderscore(parts[i]);

    return {
      domain: domain,
      protocol: protocol,
      type: type,
      subtype: subtype,
    };
  } else {
    // the name can contain dots as of RFC 6763 4.1.1.
    const name = removePrefixedUnderscore(parts.slice(0, i + 1).join("."));

    return {
      domain: domain,
      protocol: protocol,
      type: type,
      name: name,
    };
  }
}

export function stringify(parts: FQDNParts | SubTypePTRParts): string {
  assert(parts.type, "type cannot be undefined");
  assert(parts.type.length <= 15, "type must not be longer than 15 characters");

  let prefix;
  if (isSubTypePTRParts(parts)) {
    prefix = `_${parts.subtype}._sub.`;
  } else {
    prefix = parts.name? `${parts.name}.`: "";
  }

  return `${prefix}_${parts.type}._${parts.protocol || Protocol.TCP}.${parts.domain || "local"}.`;
}

export function formatHostname(hostname: string, domain = "local"): string {
  assert(!hostname.endsWith("."), "hostname must not end with the root label!");
  const tld = "." + domain;
  return (!hostname.endsWith(tld)? hostname + tld: hostname) + ".";
}

export function removeTLD(hostname: string): string {
  if (hostname.endsWith(".")) { // check for the DNS root label
    hostname = hostname.substring(0, hostname.length - 1);
  }
  const lastDot = hostname.lastIndexOf(".");
  return hostname.slice(0, lastDot);
}

export function enlargeIPv6(address: string): string {
  assert(net.isIPv6(address), "Illegal argument. Must be ipv6 address!");

  // Check if the address is an IPv4-mapped IPv6 address
  if (address.includes(".")) {
    const ipv4Address = address.split(".").slice(-4).join(".");
    return ipv4Address;
  }

  assert(!address.includes("."), "ipv4-mapped ipv6 addresses are currently unsupported!");

  const split = address.split(":");

  if (split[0] === "") {
    split.splice(0, 1);

    while (split.length < 8) {
      split.unshift("0000");
    }
  } else if (split[split.length - 1] === "") {
    split.splice(split.length -1, 1);

    while (split.length < 8) {
      split.push("0000");
    }
  } else if (split.length < 8) {
    let emptySection: number;
    for (emptySection = 0; emptySection < split.length; emptySection++) {
      if (split[emptySection] === "") { // find the first empty section
        break;
      }
    }

    const replacements: string [] = new Array(9 - split.length).fill("0000");
    split.splice(emptySection, 1, ...replacements);
  }

  for (let i = 0; i < split.length; i++) {
    const element = split[i];
    if (element.length < 4) {
      const zeros = new Array(4 - element.length).fill("0").join("");
      split.splice(i, 1, zeros + element);
    }
  }

  const result = split.join(":");
  assert(split.length <= 8, `Resulting ipv6 address has more than 8 sections (${result})!`);
  return result;
}

export function shortenIPv6(address: string | string[]): string {
  if (typeof address === "string") {
    address = address.split(":");
  }

  for (let i = 0; i < address.length; i++) {
    const part = address[i];

    let j = 0;
    for (; j < Math.min(3, part.length - 1); j++) { // search for the first index which is non-zero, but leaving at least one zero
      if (part.charAt(j) !== "0") {
        break;
      }
    }

    address[i] = part.substr(j);
  }

  let longestBlockOfZerosIndex = -1;
  let longestBlockOfZerosLength = 0;

  for (let i = 0; i < address.length; i++) { // this is not very optimized, but it works
    if (address[i] !== "0") {
      continue;
    }

    let zerosCount = 1;
    let j = i + 1;
    for (; j < address.length; j++) {
      if (address[j] === "0") {
        zerosCount++;
      } else {
        break;
      }
    }

    if (zerosCount > longestBlockOfZerosLength) {
      longestBlockOfZerosIndex = i;
      longestBlockOfZerosLength = zerosCount;
    }

    i = j; // skip all the zeros we already checked + the one after that, we know that's not a zero
  }

  if (longestBlockOfZerosIndex !== -1) {
    const startOrEnd = longestBlockOfZerosIndex === 0 || (longestBlockOfZerosIndex + longestBlockOfZerosLength === 8);
    address[longestBlockOfZerosIndex] = startOrEnd? ":": "";

    if (longestBlockOfZerosLength > 1) {
      address.splice(longestBlockOfZerosIndex + 1, longestBlockOfZerosLength - 1);
    }
  }

  const result = address.join(":");

  if (result === ":") { // special case for the unspecified address
    return "::";
  }

  return result;
}

export function formatReverseAddressPTRName(address: string): string {
  if (net.isIPv4(address)) {
    const split = address.split(".").reverse();

    return split.join(".") + ".in-addr.arpa";
  } else if (net.isIPv6(address)) {
    address = enlargeIPv6(address).toUpperCase();

    const nibbleSplit = address.replace(/:/g, "").split("").reverse();
    assert(nibbleSplit.length === 32, "Encountered invalid ipv6 address length! " + nibbleSplit.length);

    return nibbleSplit.join(".") + ".ip6.arpa";
  } else {
    throw new Error("Supplied illegal ip address format: " + address);
  }
}

export function ipAddressFromReversAddressName(name: string): string {
  name = name.toLowerCase();

  if (name.endsWith(".in-addr.arpa")) {
    const split = name.replace(".in-addr.arpa", "").split(".").reverse();

    return split.join(".");
  } else if (name.endsWith(".ip6.arpa")) {
    const split = name.replace(".ip6.arpa", "").split(".").reverse();
    assert(split.length === 32, "Encountered illegal length for .ip6.arpa split!");

    const parts: string[] = [];
    for (let i = 0; i < split.length; i += 4) {
      parts.push(split.slice(i, i + 4).join(""));
    }

    return shortenIPv6(parts.join(":"));
  } else {
    throw new Error("Supplied unknown reverse address name format: " + name);
  }
}

export function getNetAddress(address: string, netmask: string): string {
  assert(net.isIP(address) === net.isIP(netmask), "IP address version must match. Netmask cannot have a version different from the address!");

  if (net.isIPv4(address)) {
    const addressParts = address.split(".");
    const netmaskParts = netmask.split(".");
    const netAddressParts = new Array(4);

    for (let i = 0; i < addressParts.length; i++) {
      const addressNum = parseInt(addressParts[i]);
      const netmaskNum = parseInt(netmaskParts[i]);

      netAddressParts[i] = (addressNum & netmaskNum).toString();
    }

    return netAddressParts.join(".");
  } else if (net.isIPv6(address)) {
    const addressParts = enlargeIPv6(address).split(":");
    const netmaskParts = enlargeIPv6(netmask).split(":");

    const netAddressParts = new Array(8);

    for (let i = 0; i < addressParts.length; i++) {
      const addressNum = parseInt(addressParts[i], 16);
      const netmaskNum = parseInt(netmaskParts[i], 16);

      netAddressParts[i] = (addressNum & netmaskNum).toString(16);
    }

    return shortenIPv6(enlargeIPv6(netAddressParts.join(":")));
  } else {
    throw new Error("Illegal argument. Address is not an ip address!");
  }
}
