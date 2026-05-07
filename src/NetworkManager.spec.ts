/* eslint-disable @typescript-eslint/ban-ts-comment */
import { NetworkManager, NetworkInterface, InterfaceName } from "./NetworkManager";
import childProcess, { ExecException } from "child_process";
import os from "os";

const execMock = jest.spyOn(childProcess, "exec");

// @ts-expect-error
const getLinuxNetworkInterfaces = NetworkManager.getLinuxNetworkInterfaces;

describe(NetworkManager, () => {
  describe(getLinuxNetworkInterfaces, () => {
    it("should parse interfaces from ip link show", async () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, _options: unknown, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        if (command !== "ip -o link show") {
          console.warn("Command for getLinuxNetworkInterfaces differs from the expected input!");
        }

        callback(null,
          "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\ link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n" +
          "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\\ link/ether 00:00:00:00:00:01 brd ff:ff:ff:ff:ff:ff\n" +
          "3: asdf: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\\ link/ether 00:00:00:00:00:02 brd ff:ff:ff:ff:ff:ff\n" +
          "4: eth1: <BROADCAST,MULTICAST> mtu 1500 qdisc noop state DOWN mode DEFAULT group default qlen 1000\\ link/ether 00:00:00:00:00:03 brd ff:ff:ff:ff:ff:ff\n" +
          "5: eth3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\\ link/ether 00:00:00:00:00:04 brd ff:ff:ff:ff:ff:ff\n" +
          "6: eth6: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000\\ link/ether 00:00:00:00:00:05 brd ff:ff:ff:ff:ff:ff\n", "");
      });

      const names = await getLinuxNetworkInterfaces();
      expect(names).toStrictEqual(["eth0", "asdf", "eth1", "eth3", "eth6"]);
    });

    it("should handle error caused by exec", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, _options: unknown, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        callback(new Error("test"), "3: asdf: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\\ link/ether 00:00:00:00:00:02 brd ff:ff:ff:ff:ff:ff\n", "");
      });

      return getLinuxNetworkInterfaces().then(() => {
        fail("Should not parse names when error is received!");
      }, reason => {
        expect(reason.message).toBe("test");
      });
    });

    it("should handle double spaces correctly", async () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, _options: unknown, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        if (command !== "ip -o link show") {
          console.warn("Command for getLinuxNetworkInterfaces differs from the expected input!");
        }

        // ip -o link show output with extra leading/trailing whitespace per line
        callback(null,
          "  1:  lo:  <LOOPBACK,UP,LOWER_UP> mtu 65536\n" +
          "  2:  eth0:  <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n" +
          "  3:  asdf:  <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n" +
          "  4:  eth1:  <BROADCAST,MULTICAST> mtu 1500\n" +
          "  5:  eth3:  <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n" +
          "  6:  eth6:  <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n", "");
      });

      const names = await getLinuxNetworkInterfaces();
      expect(names).toStrictEqual(["eth0", "asdf", "eth1", "eth3", "eth6"]);
    });

    it("should handle empty output", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, _options: unknown, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        callback(null, "", "");
      });

      return getLinuxNetworkInterfaces().then(() => {
        fail("Should not parse names when error is received!");
      }, reason => {
        expect(reason).toBeDefined();
      });
    });
  });

  describe("checkForNewInterfaces - loopback tracking", () => {
    // Build a NetworkManager without invoking the constructor so we don't open
    // sockets or enumerate the host's real interfaces.
    function makeBareManager(): NetworkManager {
      const manager = Object.create(NetworkManager.prototype) as NetworkManager;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).currentInterfaces = new Map<InterfaceName, NetworkInterface>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).loopbackInterfaces = new Map<InterfaceName, NetworkInterface>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).currentTimer = setTimeout(() => { /* no-op */ }, 1_000_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).currentTimer.unref();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).scheduleNextJob = () => { /* no-op */ };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).emit = () => true; // swallow NETWORK_UPDATE events
      return manager;
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // Regression: when a NEW interface appeared post-startup the new-interface
    // branch wrote to currentInterfaces twice instead of populating
    // loopbackInterfaces. isLoopbackNetaddressV4 then never matched the
    // runtime-added loopback, so the cross-interface packet filter on Linux
    // failed for these interfaces.
    it("places a runtime-added loopback into loopbackInterfaces", async () => {
      const manager = makeBareManager();
      const lo: NetworkInterface = {
        name: "lo",
        loopback: true,
        mac: "00:00:00:00:00:00",
        ipv4: "127.0.0.1",
        ipv4Netaddress: "127.0.0.0",
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).getCurrentNetworkInterfaces = jest.fn().mockResolvedValue(
        new Map([["lo", lo]]),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).checkForNewInterfaces();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).loopbackInterfaces.has("lo")).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).currentInterfaces.has("lo")).toBe(true);
      expect(manager.isLoopbackNetaddressV4("127.0.0.0")).toBe(true);
    });

    // Regression: getCurrentNetworkInterfaces asserted that every listed
    // interface exposed at least one usable IP — but the newer `ip -o link
    // show` helper enumerates more virtual/down interfaces, and `excludeIpv6`
    // can filter out the only addresses on an IPv6-only link. Both cases
    // crashed the entire enumeration. The fix skips such interfaces.
    it("skips an interface with no usable addresses instead of crashing the scan", async () => {
      const manager = makeBareManager();
      // Configure the bare manager for the production code path of
      // getCurrentNetworkInterfaces.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).restrictedInterfaces = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).excludeIpv6 = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).excludeIpv6Only = false;

      // getNetworkInterfaceNames is private/static; cast via any to spy on it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const namesSpy = jest.spyOn(NetworkManager as any, "getNetworkInterfaceNames")
        .mockResolvedValue(["eth0", "veth_dead"] as never);
      const osSpy = jest.spyOn(os, "networkInterfaces").mockReturnValue({
        eth0: [{
          family: "IPv4",
          address: "192.168.1.10",
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:01",
          internal: false,
          cidr: "192.168.1.10/24",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any],
        // veth_dead has no usable address — the legacy assert blew up here.
        veth_dead: [],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (manager as any).getCurrentNetworkInterfaces();

      expect(result.has("eth0")).toBe(true);
      expect(result.has("veth_dead")).toBe(false);

      namesSpy.mockRestore();
      osSpy.mockRestore();
    });

    it("skips an IPv6-only interface when excludeIpv6 strips its addresses", async () => {
      const manager = makeBareManager();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).restrictedInterfaces = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).excludeIpv6 = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).excludeIpv6Only = false;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const namesSpy = jest.spyOn(NetworkManager as any, "getNetworkInterfaceNames")
        .mockResolvedValue(["v6only"] as never);
      const osSpy = jest.spyOn(os, "networkInterfaces").mockReturnValue({
        v6only: [{
          family: "IPv6",
          address: "fe80::1",
          netmask: "ffff:ffff:ffff:ffff::",
          mac: "00:00:00:00:00:02",
          internal: false,
          scopeid: 1,
          cidr: "fe80::1/64",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (manager as any).getCurrentNetworkInterfaces();

      // The interface had only an IPv6 address but excludeIpv6 filtered it
      // out — the resulting (no-address) interface must be skipped, not
      // turned into a crash.
      expect(result.size).toBe(0);

      namesSpy.mockRestore();
      osSpy.mockRestore();
    });

    it("does not place non-loopback interfaces into loopbackInterfaces", async () => {
      const manager = makeBareManager();
      const eth: NetworkInterface = {
        name: "eth0",
        loopback: false,
        mac: "00:00:00:00:00:01",
        ipv4: "192.168.1.10",
        ipv4Netaddress: "192.168.1.0",
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (manager as any).getCurrentNetworkInterfaces = jest.fn().mockResolvedValue(
        new Map([["eth0", eth]]),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (manager as any).checkForNewInterfaces();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).loopbackInterfaces.has("eth0")).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((manager as any).currentInterfaces.has("eth0")).toBe(true);
    });
  });

});
