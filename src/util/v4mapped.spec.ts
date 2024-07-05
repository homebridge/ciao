import { isIPv4Mapped } from "./v4mapped";

describe("isIPv4Mapped", () => {
  test("should return true for valid IPv4-mapped IPv6 address", () => {
    expect(isIPv4Mapped("::ffff:192.168.0.1")).toBe(true);

    // Test case-insensitivity
    expect(isIPv4Mapped("::FFFF:127.0.0.1")).toBe(true);
  });

  test("should return false for non-IPv4-mapped IPv6 address", () => {
    expect(isIPv4Mapped("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(false);
    expect(isIPv4Mapped("fe80::1ff:fe23:4567:890a")).toBe(false);
  });

  test("should return false for IPv4 address", () => {
    expect(isIPv4Mapped("192.168.0.1")).toBe(false);
    expect(isIPv4Mapped("127.0.0.1")).toBe(false);
  });

  test("should return false for invalid IPv4-mapped IPv6 address", () => {
    expect(isIPv4Mapped("::ffff:999.999.999.999")).toBe(false);
    expect(isIPv4Mapped("::ffff:192.168.0.256")).toBe(false);
    expect(isIPv4Mapped("::ffff:192.168.0")).toBe(false);
    expect(isIPv4Mapped("::ffff:192.168.0.1.1")).toBe(false);
  });

  test("should return false for malformed addresses", () => {
    expect(isIPv4Mapped("::ffff:192.168.0.1g")).toBe(false);
    expect(isIPv4Mapped("::ffff:192.168.0.")).toBe(false);
    expect(isIPv4Mapped("::ffff:192.168..0.1")).toBe(false);
    expect(isIPv4Mapped("::gggg:192.168.0.1")).toBe(false);
  });

  test("should return false for empty string", () => {
    expect(isIPv4Mapped("")).toBe(false);
  });

  test("should return false for null or undefined", () => {
    expect(isIPv4Mapped(null as unknown as string)).toBe(false);
    expect(isIPv4Mapped(undefined as unknown as string)).toBe(false);
  });
});

