// name equality checks according to RFC 1035 3.1

const asciiPattern = /[A-Z]/g;

export function dnsLowerCase(value: string): string {
  return value.replace(asciiPattern, s => s.toLowerCase());
}

export default function dnsEqual(name0: string, name1: string): boolean {
  return dnsLowerCase(name0) === dnsLowerCase(name1);
}
