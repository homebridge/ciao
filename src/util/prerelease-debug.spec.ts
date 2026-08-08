import { prereleaseDebugNamespaces } from "./prerelease-debug";

describe(prereleaseDebugNamespaces, () => {
  describe("on a stable build", () => {
    it.each([undefined, "", "express:*", "ciao:*"])("never enables anything, whatever DEBUG is (%p)", (debugEnv) => {
      expect(prereleaseDebugNamespaces("1.3.11", debugEnv, false)).toBeNull();
    });
  });

  describe("on a beta build", () => {
    it("enables ciao's namespaces when DEBUG is unset", () => {
      expect(prereleaseDebugNamespaces("1.3.11-beta.2", undefined, false)).toBe("ciao:*");
    });

    // Regression (homebridge/ciao#72): the old guard was `if (!debug)`, and an empty
    // string is falsy, so `DEBUG=` was indistinguishable from DEBUG being unset. A
    // consumer pinning a beta had no way to decline the output - and since the enable
    // covers the namespaces the probe/announce retries log to, they could not get a
    // quiet console, nor verify they would get one on the stable release.
    it("treats an explicitly empty DEBUG as an opt-out", () => {
      expect(prereleaseDebugNamespaces("1.3.11-beta.2", "", false)).toBeNull();
    });

    it("appends to an existing DEBUG rather than replacing it", () => {
      expect(prereleaseDebugNamespaces("1.3.11-beta.2", "express:*", false)).toBe("express:*,ciao:*");
    });

    it("leaves DEBUG alone when it already asks for ciao", () => {
      expect(prereleaseDebugNamespaces("1.3.11-beta.2", "ciao:Responder", false)).toBeNull();
    });
  });

  describe("under bonjour conformance testing", () => {
    it("enables ciao's namespaces on a stable build too", () => {
      expect(prereleaseDebugNamespaces("1.3.11", undefined, true)).toBe("ciao:*");
    });

    it("still honours an explicit opt-out", () => {
      expect(prereleaseDebugNamespaces("1.3.11", "", true)).toBeNull();
    });
  });
});
