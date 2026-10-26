import { DNSLabelCoder } from "../coder/DNSLabelCoder";
import { escapeLabel, splitLabels, splitRelativeName, wireLength } from "./dns-labels";

// Names in presentation form, the raw labels each splits into, and the presentation form those labels escape back into, which is the name itself for
// every spelling the escape produces and the canonical spelling for an escape of another character.
const names: [string, string[], string][] = [
  ["My Device._hap._tcp.local.", ["My Device", "_hap", "_tcp", "local", ""], "My Device._hap._tcp.local."],
  ["Mr\\. Coffee._hap._tcp.local.", ["Mr. Coffee", "_hap", "_tcp", "local", ""], "Mr\\. Coffee._hap._tcp.local."],
  ["Foo\\\\Bar._hap._tcp.local.", ["Foo\\Bar", "_hap", "_tcp", "local", ""], "Foo\\\\Bar._hap._tcp.local."],
  ["A\\.B\\\\C.local.", ["A.B\\C", "local", ""], "A\\.B\\\\C.local."],
  ["\\.start.local.", [".start", "local", ""], "\\.start.local."],
  ["end\\..local.", ["end.", "local", ""], "end\\..local."],
  ["a\\Xb.local.", ["aXb", "local", ""], "aXb.local."],
];

describe("dns-labels", () => {
  describe(splitLabels, () => {
    it.each(names)("should split %s into its raw labels and escape them back", (name, labels, escaped) => {
      expect(splitLabels(name)).toEqual(labels);
      expect(splitLabels(name).map(escapeLabel).join(".")).toBe(escaped);
    });

    it("should refuse a name ending with an escaped dot", () => {
      expect(() => splitLabels("a\\.")).toThrow(/escaped dot/);
    });
  });

  describe(splitRelativeName, () => {
    it.each([
      ["foo\\", ["foo"]],
      ["a\\.", ["a."]],
      ["a\\\\", ["a\\"]],
      ["a.b", ["a", "b"]],
      ["a.", ["a", ""]],
    ])("should split %s into the raw labels %j", (name, labels) => {
      expect(splitRelativeName(name)).toEqual(labels);
    });
  });

  describe(escapeLabel, () => {
    it("should escape each dot and backslash and leave any other label as it is", () => {
      expect(escapeLabel("Mr. Coffee")).toBe("Mr\\. Coffee");
      expect(escapeLabel("a\\b.c")).toBe("a\\\\b\\.c");
      expect(escapeLabel("Living Room")).toBe("Living Room");
    });
  });

  describe(wireLength, () => {
    it.each(names.map(([name]) => name))("should equal the coder's uncompressed length for %s", name => {
      expect(wireLength(splitLabels(name))).toBe(new DNSLabelCoder().getUncompressedNameLength(name));
    });
  });
});
