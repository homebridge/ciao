import {Protocol} from "../index";
import {ServiceType} from "../CiaoService";
import assert from "assert";

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
  } else if (i === 0) {
    // TODO the name can contain dots as of RFC 6763 4.1.1.
    const name = removePrefixedUnderscore(parts[i]);

    return {
      domain: domain,
      protocol: protocol,
      type: type,
      name: name,
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
  }

  throw new Error("Unable to parse fqdn: " + fqdn);
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

  return `${prefix}_${parts.type}._${parts.protocol || Protocol.TCP}.${parts.domain || "local"}`;
}

export function formatHostname(hostname: string, domain = "local"): string {
  const tld = "." + domain;
  return !hostname.endsWith(tld)? hostname + tld: hostname;
}
