import assert from "assert";
import net from "net";
import { ServiceType } from "../CiaoService";
import { Protocol } from "../index";
import { escapeLabel, splitLabels } from "./dns-labels";
import { getIPFromV4Mapped, isIPv4Mapped } from "./v4mapped";

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
  const parts = splitLabels(fqdn);

  assert(parts.length >= 3, "Received illegal fqdn: " + fqdn);

  let i = parts.length - 1;

  // The domain is rebuilt in presentation form, the form stringify writes it in, so each of its labels is escaped, while the name, the type and the subtype
  // are single labels and are returned raw.
  let domain = "";
  while (!isProtocol(parts[i])) {
    domain = escapeLabel(removePrefixedUnderscore(parts[i])) + (domain? "." + domain: "");
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
    assert(i === 0, "Received illegal formatted instance fqdn: " + fqdn);

    const name = removePrefixedUnderscore(parts[i]);

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

  // An instance name and a subtype may hold any text (RFC 6763 4.1.1 and 7.1), so each is escaped into one label, while RFC 6763 7 holds a service type to
  // letters, digits and hyphens, so the type is left as given.
  let prefix;
  if (isSubTypePTRParts(parts)) {
    prefix = "_" + escapeLabel(parts.subtype) + "._sub.";
  } else {
    prefix = parts.name? escapeLabel(parts.name) + ".": "";
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

export function formatMappedIPv4Address(address: string): string {
  assert(net.isIPv4(address), "Illegal argument. Must be an IPv4 address!");

  // Convert IPv4 address to its hexadecimal representation
  const hexParts = address.split(".").map(part => parseInt(part).toString(16).padStart(2, "0"));
  const ipv6Part = `::ffff:${hexParts.join("")}`;

  // Convert the hexadecimal representation to the standard IPv6 format
  return ipv6Part.replace(/(.{4})(.{4})$/, "$1:$2");
}

export function enlargeIPv6(address: string): string {
  assert(net.isIPv6(address), "Illegal argument. Must be ipv6 address!");

  const parts = address.split("::");
  
  // Initialize head and tail arrays
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];
  
  // Calculate the number of groups to fill in with "0000" when we expand
  const fill = new Array(8 - head.length - tail.length).fill("0000");
  
  // Combine it all and normalize each hextet to be 4 characters long
  return [...head, ...fill, ...tail].map(hextet => hextet.padStart(4, "0")).join(":");
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

    address[i] = part.slice(j);
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

  // RFC 5952 4.2.2 forbids "::" for a single zero hextet, so only a run of two or more is compressed and a lone zero stays "0".
  if (longestBlockOfZerosLength > 1) {
    const startOrEnd = longestBlockOfZerosIndex === 0 || (longestBlockOfZerosIndex + longestBlockOfZerosLength === 8);
    address[longestBlockOfZerosIndex] = startOrEnd? ":": "";
    address.splice(longestBlockOfZerosIndex + 1, longestBlockOfZerosLength - 1);
  }

  const result = address.join(":");

  if (result === ":") { // special case for the unspecified address
    return "::";
  }

  return result;
}

/**
 * Spells an IPv6 address in the text form of RFC 5952 section 4: lowercase hex digits, no leading zeros in a hextet, and the longest run of two or more
 * zero hextets, the first on a tie, compressed to "::". Text that enters ciao from outside passes through here: the address of a record built by name,
 * every address the operating system reports and every address a consumer gives in its options, so different spellings of one address compare equal as
 * strings. Hextets ciao formats itself with `toString(16)` are lowercase with no leading zeros already, so `shortenIPv6` alone gives them the same text.
 *
 * @param address - An IPv6 address in any spelling `net.isIPv6` accepts.
 */
export function canonicalizeIPv6(address: string): string {
  return shortenIPv6(enlargeIPv6(address.toLowerCase()));
}

export function formatReverseAddressPTRName(address: string): string {
  if (net.isIPv4(address)) {
    const split = address.split(".").reverse();

    return split.join(".") + ".in-addr.arpa";
  } 

  if (!net.isIPv6(address)) {
    throw new Error("Supplied illegal ip address format: " + address);
  }

  if (isIPv4Mapped(address)) {
    return (getIPFromV4Mapped(address) as string).split(".").reverse().join(".") + ".in-addr.arpa";
  }

  address = enlargeIPv6(address).toUpperCase();

  const nibbleSplit = address.replace(/:/g, "").split("").reverse();
  assert(nibbleSplit.length === 32, "Encountered invalid ipv6 address length! " + nibbleSplit.length);

  return nibbleSplit.join(".") + ".ip6.arpa";
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

    return shortenIPv6(netAddressParts);
  } else {
    throw new Error("Illegal argument. Address is not an ip address!");
  }
}
