/* eslint-disable @typescript-eslint/ban-ts-comment */
import { NetworkManager } from "./NetworkManager";
import childProcess, { ExecException } from "child_process";

const execMock = jest.spyOn(childProcess, "exec");

// @ts-expect-error
const getLinuxNetworkInterfaces = NetworkManager.getLinuxNetworkInterfaces;

describe(NetworkManager, () => {
  describe(getLinuxNetworkInterfaces, () => {
    it("should parse interfaces from arp cache", async () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        if (command !== "ip neigh show") {
          console.warn("Command for getLinuxNetworkInterfaces differs from the expected input!");
        }

        callback(null, "192.168.0.1 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "192.168.0.2 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "192.168.0.3 dev asdf lladdr 00:00:00:00:00:00 REACHABLE\n" +
          "192.168.0.4 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "192.168.0.5 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "2003::1 dev eth1 lladdr 00:00:00:00:00:00 STALE\n" +
          "2003::1 dev eth0 lladdr 00:00:00:00:00:00 REACHABLE\n" +
          "fe80::1 dev eth3 lladdr 00:00:00:00:00:00 STALE\n" +
          "2003::1 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "fd00::1 dev eth6 lladdr 00:00:00:00:00:00 STALE\n", "");
      });

      const names = await getLinuxNetworkInterfaces();
      expect(names).toStrictEqual(["eth0", "asdf", "eth1", "eth3", "eth6"]);
    });

    it("should handle error caused by exec", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        callback(new Error("test"), "192.168.0.3 dev asdf lladdr 00:00:00:00:00:00 REACHABLE\n", "");
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
        if (command !== "ip neigh show") {
          console.warn("Command for getLinuxNetworkInterfaces differs from the expected input!");
        }

        callback(null, "192.168.0.1 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "192.168.0.2 dev   eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "192.168.0.3 dev asdf lladdr 00:00:00:00:00:00 REACHABLE\n" +
          "192.168.0.4 dev  eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "192.168.0.5 dev eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "2003::1   dev eth1 lladdr 00:00:00:00:00:00 STALE\n" +
          "2003::1 dev eth0 lladdr 00:00:00:00:00:00 REACHABLE\n" +
          "fe80::1  dev eth3 lladdr 00:00:00:00:00:00 STALE\n" +
          "2003::1 dev   eth0 lladdr 00:00:00:00:00:00 STALE\n" +
          "fd00::1 dev eth6 lladdr 00:00:00:00:00:00 STALE\n", "");
      });

      const names = await getLinuxNetworkInterfaces();
      expect(names).toStrictEqual(["eth0", "asdf", "eth1", "eth3", "eth6"]);
    });

    it("should handle empty arp cache", () => {
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
