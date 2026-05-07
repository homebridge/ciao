/* eslint-disable @typescript-eslint/ban-ts-comment */
import { NetworkManager, NetworkInterface, InterfaceName } from "./NetworkManager";
import childProcess, { ExecException } from "child_process";

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
