import dnsEqual from "./dns-equal";

describe(dnsEqual, () => {
  it("should run positive tests", () => {
    expect(dnsEqual("Foo", "foo")).toBe(true);
    expect(dnsEqual("FooÆØÅ", "fooÆØÅ")).toBe(true);
  });

  it("should run negative tests", () => {
    expect(dnsEqual("Foo", "bar")).toBe(false);
    expect(dnsEqual("FooÆØÅ", "fooæøå")).toBe(false);
    expect(dnsEqual("café", "cafe")).toBe(false);
  });
});
