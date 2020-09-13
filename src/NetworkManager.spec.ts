/* eslint-disable @typescript-eslint/ban-ts-comment */
import { NetworkManager, InterfaceName } from "./NetworkManager";
import childProcess, { ExecException } from "child_process";

const execMock = jest.spyOn(childProcess, "exec");

// @ts-expect-error
const getLinuxDefaultNetworkInterface = NetworkManager.getLinuxDefaultNetworkInterface;

describe(NetworkManager, () => {
  describe(getLinuxDefaultNetworkInterface, () => {
    it("should parse interfaces from arp cache", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        if (command !== "arp -n -a | grep -v incomplete") {
          console.warn("Command for getLinuxDefaultNetworkInterface differs from the expected input!");
        }

        callback(null, "? (192.168.1.1) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.2) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.3) at 00:00:00:00:00:00 [ether] on asdf\n" +
          "? (192.168.1.4) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.5) at 00:00:00:00:00:00 [ether] on eth1\n" +
          "? (192.168.1.6) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.7) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.8) at 00:00:00:00:00:00 [ether] on eth3\n" +
          "? (192.168.1.9) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.10) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.11) at 00:00:00:00:00:00 [ether] on eth6\n", "");
      });

      return getLinuxDefaultNetworkInterface().then((names: InterfaceName[]) => {
        expect(names).toStrictEqual(["eth0", "asdf", "eth1", "eth3", "eth6"]);
      });
    });

    it("should handle error caused by exec", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        callback(new Error("test"), "? (192.168.1.1) at 00:00:00:00:00:00 [ether] on eth0\n", "");
      });

      return getLinuxDefaultNetworkInterface().then(() => {
        fail("Should not parse names when error is received!");
      }, reason => {
        expect(reason.message).toBe("test");
      });
    });

    it("should handle double spaces correctly", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        if (command !== "arp -n -a | grep -v incomplete") {
          console.warn("Command for getLinuxDefaultNetworkInterface differs from the expected input!");
        }

        callback(null, "? (192.168.1.1) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.2) at 00:00:00:00:00:00 [ether]  on eth0\n" +
          "? (192.168.1.3) at 00:00:00:00:00:00 [ether]  on asdf\n" +
          "? (192.168.1.4) at 00:00:00:00:00:00 [ether]  on eth0\n" +
          "? (192.168.1.5) at 00:00:00:00:00:00 [ether] on eth1\n" +
          "? (192.168.1.6) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.7) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.8) at 00:00:00:00:00:00 [ether]  on eth3\n" +
          "? (192.168.1.9) at 00:00:00:00:00:00 [ether] on eth0\n" +
          "? (192.168.1.10) at 00:00:00:00:00:00 [ether]  on eth0\n" +
          "? (192.168.1.11) at 00:00:00:00:00:00 [ether] on eth6\n", "");
      });

      return getLinuxDefaultNetworkInterface().then((names: InterfaceName[]) => {
        expect(names).toStrictEqual(["eth0", "asdf", "eth1", "eth3", "eth6"]);
      });
    });

    it("should handle empty arp cache", () => {
      // @ts-expect-error
      execMock.mockImplementationOnce((command: string, callback: (error: ExecException | null, stdout: string, stderr: string) => void) => {
        callback(null, "", "");
      });

      return getLinuxDefaultNetworkInterface().then(() => {
        fail("Should not parse names when error is received!");
      }, reason => {
        expect(reason).toBeDefined();
      });
    });
  });
});
