/**
 * Test for the presence of an IPv4-mapped address embedded in an IPv6 address.
 *
 * @param address - IPv6 address
 * @returns true if it is an IPv4-mapped address, false otherwise.
 */
export function isIPv4Mapped(address: string): boolean {
  if(!/^::ffff:(\d{1,3}\.){3}\d{1,3}$/i.test(address)) {
    return false;
  }

  // Split the address apart into it's components and test for validity.
  const parts = address.split(/::ffff:/i)[1]?.split(".").map(Number);
  return parts?.length === 4 && parts.every(part => part >= 0 && part <= 255);
}

export function getIPFromV4Mapped(address: string): string | null {

  // Split the address apart into it's components and test for validity.
  return address.split(/^::ffff:/i)[1] ?? null;
}

