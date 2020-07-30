import assert from "assert";
import childProcess from "child_process";
import createDebug from "debug";
import { EventEmitter } from "events";
import deepEqual from "fast-deep-equal";
import net from "net";
import os, { NetworkInterfaceInfo } from "os";
import { getNetAddress } from "./util/domain-formatter";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:NetworkManager");

export type InterfaceName = string;
export type MacAddress = string;

export type IPv4Address = string;
export type IPv6Address = string;
export type IPAddress = IPv4Address | IPv6Address;

export const enum IPFamily {
  IPv4 = "IPv4",
  IPv6 = "IPv6",
}

export interface NetworkInterface {
  name: InterfaceName;
  loopback: boolean;
  mac: MacAddress;

  // one of ipv4 or ipv6 will be present, most of the time even both
  ipv4?: IPv4Address;
  ip4Netmask?: IPv4Address;
  ipv4Netaddress?: IPv4Address;
  ipv6?: IPv6Address; // link-local ipv6 fe80::/10
  ipv6Netmask?: IPv6Address;

  globallyRoutableIpv6?: IPv6Address; // first routable ipv6 address
  globallyRoutableIpv6Netmask?: IPv6Address;

  uniqueLocalIpv6?: IPv6Address; // fc00::/7 (those are the fd ula addresses; fc prefix isn't really used, used for globally assigned ula)
  uniqueLocalIpv6Netmask?: IPv6Address;
}

export interface NetworkUpdate {
  added?: NetworkInterface[];
  removed?: NetworkInterface[];
  changes?: InterfaceChange[];
}

export interface InterfaceChange {
  name: InterfaceName;

  outdatedIpv4?: IPv4Address;
  updatedIpv4?: IPv4Address;

  outdatedIpv6?: IPv6Address;
  updatedIpv6?: IPv6Address;

  outdatedGloballyRoutableIpv6?: IPv6Address;
  updatedGloballyRoutableIpv6?: IPv6Address;

  outdatedUniqueLocalIpv6?: IPv6Address;
  updatedUniqueLocalIpv6?: IPv6Address;
}

export interface NetworkManagerOptions {
  interface?: string | string[];
  excludeIpv6Only?: boolean;
}

export const enum NetworkManagerEvent {
  NETWORK_UPDATE = "network-update",
}

export declare interface NetworkManager {

  on(event: "network-update", listener: (networkUpdate: NetworkUpdate) => void): this;

  emit(event: "network-update", networkUpdate: NetworkUpdate): boolean;

}

/**
 * The NetworkManager maintains a representation of the network interfaces define on the host system.
 * It periodically checks for updated network information.
 *
 * The NetworkManager makes the following decision when checking for interfaces:
 * * First of all it gathers the default network interface of the system (by checking the routing table of the os)
 * * The following interfaces are going to be tracked:
 *   * The loopback interface
 *   * All interfaces which match the subnet of the default interface
 *   * All interfaces which contain a globally unique (aka globally routable) ipv6 address
 */
export class NetworkManager extends EventEmitter {

  private static readonly POLLING_TIME = 15 * 1000; // 15 seconds

  private readonly restrictedInterfaces?: InterfaceName[];
  private readonly excludeIpv6Only: boolean;

  private currentInterfaces: Map<InterfaceName, NetworkInterface> = new Map();
  private initPromise?: Promise<void>;

  private currentTimer?: Timeout;

  constructor(options?: NetworkManagerOptions) {
    super();

    if (options && options.interface) {
      if (typeof options.interface === "string" && net.isIP(options.interface)) {
        const interfaceName = NetworkManager.resolveInterface(options.interface);

        if (interfaceName) {
          this.restrictedInterfaces = [interfaceName];
        } else {
          console.log("CIAO: Interface was specified as ip (%s), though couldn't find a matching interface for the given address. " +
            "Going to fallback to bind on all available interfaces.", options.interface);
        }
      } else {
        this.restrictedInterfaces = Array.isArray(options.interface)? options.interface: [options.interface];
      }
    }
    this.excludeIpv6Only = !!(options && options.excludeIpv6Only);

    if (options) {
      debug("Created NetworkManager with options: %s", JSON.stringify(options));
    }

    this.initPromise = new Promise(resolve => {
      // below call takes about 20-30ms
      this.getCurrentNetworkInterfaces().then(map => {
        this.currentInterfaces = map;

        const interfaceNames: InterfaceName[] = [];
        for (const name of this.currentInterfaces.keys()) {
          interfaceNames.push(name);
        }
        debug("Initial networks [%s]", interfaceNames.join(", "));

        this.initPromise = undefined;
        resolve();

        this.scheduleNextJob();
      });
    });
  }

  public async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  public shutdown(): void {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
  }

  public getInterfaceMap(): Map<InterfaceName, NetworkInterface> {
    if (this.initPromise) {
      assert.fail("Not yet initialized!");
    }
    return this.currentInterfaces;
  }

  public getInterface(name: InterfaceName): NetworkInterface | undefined {
    if (this.initPromise) {
      assert.fail("Not yet initialized!");
    }
    return this.currentInterfaces.get(name);
  }

  private scheduleNextJob(): void {
    const timer = setTimeout(this.checkForNewInterfaces.bind(this), NetworkManager.POLLING_TIME);
    timer.unref(); // this timer won't prevent shutdown
  }

  private async checkForNewInterfaces(): Promise<void> {
    debug("Checking for new networks..."); // TODO remove on stable

    const latestInterfaces = await this.getCurrentNetworkInterfaces();

    let added: NetworkInterface[] | undefined = undefined;
    let removed: NetworkInterface[] | undefined = undefined;
    let changes: InterfaceChange[] | undefined = undefined;

    for (const [name, networkInterface] of latestInterfaces) {
      const currentInterface = this.currentInterfaces.get(name);

      if (currentInterface) { // the interface could potentially have changed
        if (!deepEqual(currentInterface, networkInterface)) {
          // indeed the interface changed
          const change: InterfaceChange = {
            name: name,
          };

          if (currentInterface.ipv4 !== networkInterface.ipv4) { // check for changed ipv4
            if (currentInterface.ipv4) {
              change.outdatedIpv4 = currentInterface.ipv4;
            }
            if (networkInterface.ipv4) {
              change.updatedIpv4 = networkInterface.ipv4;
            }
          }

          if (currentInterface.ipv6 !== networkInterface.ipv6) { // check for changed link-local ipv6
            if (currentInterface.ipv6) {
              change.outdatedIpv6 = currentInterface.ipv6;
            }
            if (networkInterface.ipv6) {
              change.updatedIpv6 = networkInterface.ipv6;
            }
          }

          if (currentInterface.globallyRoutableIpv6 !== networkInterface.globallyRoutableIpv6) { // check for changed routable ipv6
            if (currentInterface.globallyRoutableIpv6) {
              change.outdatedGloballyRoutableIpv6 = currentInterface.globallyRoutableIpv6;
            }
            if (networkInterface.globallyRoutableIpv6) {
              change.updatedGloballyRoutableIpv6 = networkInterface.globallyRoutableIpv6;
            }
          }

          if (currentInterface.uniqueLocalIpv6 !== networkInterface.uniqueLocalIpv6) { // check for changed ula
            if (currentInterface.uniqueLocalIpv6) {
              change.outdatedUniqueLocalIpv6 = currentInterface.uniqueLocalIpv6;
            }
            if (networkInterface.uniqueLocalIpv6) {
              change.updatedUniqueLocalIpv6 = networkInterface.uniqueLocalIpv6;
            }
          }

          (changes || (changes = [])) // get or create array
            .push(change);
        }
      } else { // new interface was added/started
        this.currentInterfaces.set(name, networkInterface);

        (added || (added = [])) // get or create array
          .push(networkInterface);
      }
    }

    // at this point we updated any existing interfaces and added all new interfaces
    // thus if the length of below is not the same interface must have been removed
    // this check ensures that we do not unnecessarily loop twice through our interfaces
    if (this.currentInterfaces.size !== latestInterfaces.size) {
      for (const [name, networkInterface] of this.currentInterfaces) {
        if (!latestInterfaces.has(name)) { // interface was removed
          this.currentInterfaces.delete(name);

          (removed || (removed = [])) // get or create new array
            .push(networkInterface);

        }
      }
    }

    if (added || removed || changes) { // emit an event only if anything changed
      const addedString = added? added.map(iface => iface.name).join(","): "";
      const removedString = removed? removed.map(iface => iface.name).join(","): "";
      const changesString = changes? changes.map(iface => {
        let string = `{ name: ${iface.name} `;
        if (iface.outdatedIpv4 || iface.updatedIpv4) {
          string += `, ${iface.outdatedIpv4} -> ${iface.updatedIpv4} `;
        }
        if (iface.outdatedIpv6 || iface.updatedIpv6) {
          string += `, ${iface.outdatedIpv6} -> ${iface.updatedIpv6} `;
        }
        if (iface.outdatedGloballyRoutableIpv6 || iface.updatedGloballyRoutableIpv6) {
          string += `, ${iface.outdatedGloballyRoutableIpv6} -> ${iface.updatedGloballyRoutableIpv6} `;
        }
        if (iface.outdatedUniqueLocalIpv6 || iface.updatedUniqueLocalIpv6) {
          string += `, ${iface.outdatedUniqueLocalIpv6} -> ${iface.updatedUniqueLocalIpv6} `;
        }
        return string + "}";
      }).join(","): "";

      debug("Detected network changes: added: [%s], removed: [%s], changes: [%s]!", addedString, removedString, changesString);

      this.emit(NetworkManagerEvent.NETWORK_UPDATE, {
        added: added,
        removed: removed,
        changes: changes,
      });
    }

    this.scheduleNextJob();
  }

  private async getCurrentNetworkInterfaces(): Promise<Map<InterfaceName, NetworkInterface>> {
    const defaultIp4Netaddress: IPv4Address | undefined = !this.restrictedInterfaces? await NetworkManager.getDefaultIpv4Subnet(): undefined;

    const interfaces: Map<InterfaceName, NetworkInterface> = new Map();

    Object.entries(os.networkInterfaces()).forEach(([name, infoArray]) => {

      let ipv4Info: NetworkInterfaceInfo | undefined = undefined;
      let ipv6Info: NetworkInterfaceInfo | undefined = undefined;
      let routableIpv6Info: NetworkInterfaceInfo | undefined = undefined;
      let uniqueLocalIpv6Info: NetworkInterfaceInfo | undefined = undefined;
      let internal = false;

      for (const info of infoArray) {
        if (info.internal) {
          internal = true;
        }

        if (info.family === "IPv4" && !ipv4Info) {
          ipv4Info = info;
        } else if (info.family === "IPv6") {
          if (info.scopeid && !ipv6Info) { // we only care about non zero scope (aka link-local ipv6)
            ipv6Info = info;
          } else if (info.scopeid === 0) { // global routable ipv6
            if ((info.address.startsWith("fc") || info.address.startsWith("fd")) && !uniqueLocalIpv6Info) {
              uniqueLocalIpv6Info = info;
            } else if (!routableIpv6Info) {
              routableIpv6Info = info;
            }
          }
        }

        if (ipv4Info && ipv6Info && routableIpv6Info && uniqueLocalIpv6Info) {
          break;
        }
      }

      assert(ipv4Info || ipv6Info, "Could not find valid addresses for interface '" + name + "'");

      if (this.excludeIpv6Only && !ipv4Info) {
        return;
      }

      const networkInterface: NetworkInterface = {
        name: name,
        loopback: internal,
        mac: (ipv4Info?.mac || ipv6Info?.mac)!,
      };

      if (ipv4Info) {
        networkInterface.ipv4 = ipv4Info.address;
        networkInterface.ip4Netmask = ipv4Info.netmask;
        networkInterface.ipv4Netaddress = getNetAddress(ipv4Info.address, ipv4Info.netmask);
      }

      if (ipv6Info) {
        networkInterface.ipv6 = ipv6Info.address;
        networkInterface.ipv6Netmask = ipv6Info.netmask;
      }

      if (routableIpv6Info) {
        networkInterface.globallyRoutableIpv6 = routableIpv6Info.address;
        networkInterface.globallyRoutableIpv6Netmask = routableIpv6Info.netmask;
      }

      if (uniqueLocalIpv6Info) {
        networkInterface.uniqueLocalIpv6 = uniqueLocalIpv6Info.address;
        networkInterface.uniqueLocalIpv6Netmask = uniqueLocalIpv6Info.netmask;
      }

      if (internal) {
        // we always add the loopback iface even when interfaces are restricted
        interfaces.set(name, networkInterface);
      } else if (this.restrictedInterfaces) {
        if (this.restrictedInterfaces.includes(name)) {
          interfaces.set(name, networkInterface);
        }
      } else if (networkInterface.globallyRoutableIpv6 || defaultIp4Netaddress && defaultIp4Netaddress === networkInterface.ipv4Netaddress) {
        interfaces.set(name, networkInterface);
      }
    });

    return interfaces;
  }

  public static resolveInterface(address: IPAddress): InterfaceName | undefined {
    let interfaceName: InterfaceName | undefined;

    outer: for (const [name, infoArray] of Object.entries(os.networkInterfaces())) {
      for (const info of infoArray) {
        if (info.address === address) {
          interfaceName = name;
          break outer; // exit out of both loops
        }
      }
    }

    return interfaceName;
  }

  private static async getDefaultIpv4Subnet(): Promise<IPv4Address | undefined> {
    // this method was derived from the systeminformation library (https://github.com/sebhildebrandt/systeminformation/blob/master/lib/network.js)
    // the library is licensed under the MIT license and Copyright (c) 2014-2020 Sebastian Hildebrandt

    let interfaceNamePromise;
    switch (os.platform()) {
      case "win32":
        interfaceNamePromise = this.getWinDefaultNetworkInterface();
        break;
      case "linux":
        interfaceNamePromise = this.getLinuxDefaultNetworkInterface();
        break;
      case "darwin":
      case "openbsd":
      case "freebsd":
      case "sunos":
        interfaceNamePromise = this.getDarwin_BSD_SUNOSDefaultNetworkInterface();
        break;
      default:
        debug("Found unsupported platform %s", os.platform());
        return Promise.reject(new Error("unsupported platform!"));
    }

    let interfaceName;
    try {
      interfaceName = await interfaceNamePromise;
    } catch (error) {
      debug("Could not check hosts routing table for default network interface: " + error.message);
      return undefined;
    }

    const infos: NetworkInterfaceInfo[] = os.networkInterfaces()[interfaceName];
    if (!infos) {
      debug("The network interface advertised as the default interface could not be found by the os module!");
      return undefined;
    }

    let netaddress: IPv4Address | undefined = undefined;
    for (const info of infos) {
      if (info.family === "IPv4") {
        netaddress = getNetAddress(info.address, info.netmask);
      }
    }

    if (!netaddress) {
      debug("The network interface advertised as the default interface didn't have any ipv4 address records!");
    }

    return netaddress;
  }

  private static readonly WIN_CHAR_PATTERN = /[a-zA-Z]/;
  private static readonly WIN_DEFAULT_IP_PATTERN = /0\.0\.0\.0[ ]+0\.0\.0\.0/;
  private static getWinDefaultNetworkInterface(): Promise<InterfaceName> {
    return new Promise((resolve, reject) => {
      const command = "netstat -r";
      childProcess.exec(command, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        let defaultIp;
        const lines = stdout.split(os.EOL);
        for (const line of lines) {
          if (this.WIN_DEFAULT_IP_PATTERN.test(line) && !(this.WIN_CHAR_PATTERN.test(line))) {
            const parts = line.split(/[ ]+/);
            if (parts.length >= 5) {
              defaultIp = parts[parts.length - 2];
            }
          }
        }

        if (defaultIp) {
          const interfaceName = this.resolveInterface(defaultIp);
          if (interfaceName) {
            resolve(interfaceName);
            return;
          }
        }

        reject(new Error("not found!"));
      });
    });
  }

  private static readonly SPACE_PATTERN = /\s+/;
  private static getLinuxDefaultNetworkInterface(): Promise<InterfaceName> {
    return new Promise((resolve, reject) => {
      const command = "ip route 2> /dev/null | grep default";
      childProcess.exec(command, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const parts = stdout.split(os.EOL)[0].split(this.SPACE_PATTERN);

        let i = 0;
        for (; i < parts.length; i++) {
          if (parts[i] === "dev") {
            // the next index marks the interface name
            break;
          }
        }

        if (i + 1 < parts.length) {
          let interfaceName = parts[i + 1];
          if (interfaceName.indexOf(":") !== -1) {
            interfaceName = interfaceName.split(":")[1].trim();
          }

          resolve(interfaceName);
        } else {
          reject(new Error("not found!"));
        }
      });
    });
  }

  private static getDarwin_BSD_SUNOSDefaultNetworkInterface(): Promise<InterfaceName> {
    return new Promise((resolve, reject) => {
      // TODO darwin netstat -r -f inet
      const command = os.platform() === "darwin"
        ? "route get 0.0.0.0 2>/dev/null | grep interface: | awk '{print $2}'"
        : "route get 0.0.0.0 | grep interface:";
      childProcess.exec(command, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        let interfaceName = stdout.split(os.EOL)[0];
        if (interfaceName.indexOf(":") > -1) {
          interfaceName = interfaceName.split(":")[1].trim();
        }

        if (interfaceName) {
          resolve(interfaceName);
        } else {
          reject(new Error("not found"));
        }
      });
    });
  }

}
