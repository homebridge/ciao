import { MDNSServer, SendResultFailedRatio } from "./MDNSServer";
import { NetworkUpdate } from "./NetworkManager";

describe(MDNSServer, () => {
  describe("handleUpdatedNetworkInterfaces - IPv4 transitions", () => {
    let server: MDNSServer;

    beforeEach(() => {
      // Create server without binding - no real sockets are opened
      server = new MDNSServer({ handleQuery: () => {}, handleResponse: () => {} });
    });

    afterEach(() => {
      server.getNetworkManager().removeAllListeners();
    });

    it("should handle IPv4 appearing on interface (undefined → address) without crashing", () => {
      const update: NetworkUpdate = {
        changes: [{
          name: "en0",
          outdatedIpv4: undefined,
          updatedIpv4: "192.168.1.100",
        }],
      };

      // Should not throw - before fix this hit assert.fail()
      expect(() => {
        (server as any).handleUpdatedNetworkInterfaces(update);
      }).not.toThrow();
    });

    it("should handle IPv4 disappearing on interface (address → undefined) without crashing", () => {
      const update: NetworkUpdate = {
        changes: [{
          name: "en0",
          outdatedIpv4: "192.168.1.100",
          updatedIpv4: undefined,
        }],
      };

      // Should not throw - before fix this hit assert.fail()
      expect(() => {
        (server as any).handleUpdatedNetworkInterfaces(update);
      }).not.toThrow();
    });

    it("should handle both IPv4 undefined (undefined → undefined) without crashing", () => {
      const update: NetworkUpdate = {
        changes: [{
          name: "en0",
          outdatedIpv4: undefined,
          updatedIpv4: undefined,
        }],
      };

      // No-op case: no IPv4 on either side
      expect(() => {
        (server as any).handleUpdatedNetworkInterfaces(update);
      }).not.toThrow();
    });
  });

  it("SendResultFailedRatio", () => {
    expect(SendResultFailedRatio([
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
    ])).toBe(0);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0"},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0"},
      { status: "timeout", interface: "eth0"},
    ])).toBe(0.6);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "timeout", interface: "eth0"},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
    ])).toBe(1);

    expect(SendResultFailedRatio([])).toBe(0);
  });
});
