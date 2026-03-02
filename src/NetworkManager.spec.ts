/* eslint-disable @typescript-eslint/ban-ts-comment */
import { NetworkManager } from "./NetworkManager";
import childProcess, { ExecException } from "child_process";

const execMock = jest.spyOn(childProcess, "exec");

// @ts-expect-error
const getLinuxNetworkInterfaces = NetworkManager.getLinuxNetworkInterfaces;

describe(NetworkManager, () => {
  describe(getLinuxNetworkInterfaces, () => {
    it("should parse interfaces from ip link show", async () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
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
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
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
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
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
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        callback(null, "", "");
      });

      return getLinuxNetworkInterfaces().then(() => {
        fail("Should not parse names when error is received!");
      }, reason => {
        expect(reason).toBeDefined();
      });
    });
  });
});
