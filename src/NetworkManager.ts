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

export const enum WifiState {
  UNDEFINED,
  NOT_A_WIFI_INTERFACE,
  NOT_ASSOCIATED,
  CONNECTED,
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

  private static readonly SPACE_PATTERN = /\s+/g;

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
    this.currentTimer = setTimeout(this.checkForNewInterfaces.bind(this), NetworkManager.POLLING_TIME);
    this.currentTimer.unref(); // this timer won't prevent shutdown
  }

  private async checkForNewInterfaces(): Promise<void> {
    const latestInterfaces = await this.getCurrentNetworkInterfaces();
    if (!this.currentTimer) { // if the timer is undefined, NetworkManager was shut down
      return;
    }

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

          this.currentInterfaces.set(name, networkInterface);
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
    let names: InterfaceName[];
    if (this.restrictedInterfaces) {
      names = this.restrictedInterfaces;

      const loopback = NetworkManager.getLoopbackInterface();
      if (!names.includes(loopback)) {
        names.push(loopback);
      }
    } else {
      try {
        names = await NetworkManager.getNetworkInterfaceNames();
      } catch (error) {
        debug(`WARNING Detecting network interfaces for platform '${os.platform()}' failed. Trying to assume network interfaces! (${error.message})`);
        // fallback way of gathering network interfaces (remember, there are docker images where the arp command is not installed)
        names = NetworkManager.assumeNetworkInterfaceNames();
      }
    }


    const interfaces: Map<InterfaceName, NetworkInterface> = new Map();
    const networkInterfaces = os.networkInterfaces();

    for (const name of names) {
      const infos = networkInterfaces[name];
      if (!infos) {
        continue;
      }

      let ipv4Info: NetworkInterfaceInfo | undefined = undefined;
      let ipv6Info: NetworkInterfaceInfo | undefined = undefined;
      let routableIpv6Info: NetworkInterfaceInfo | undefined = undefined;
      let uniqueLocalIpv6Info: NetworkInterfaceInfo | undefined = undefined;
      let internal = false;

      for (const info of infos) {
        if (info.internal) {
          internal = true;
        }

        if (info.family === "IPv4" && !ipv4Info) {
          ipv4Info = info;
        } else if (info.family === "IPv6") {
          if (info.scopeid && !ipv6Info) { // we only care about non zero scope (aka link-local ipv6)
            ipv6Info = info;
          } else if (info.scopeid === 0) { // global routable ipv6
            if (info.address.startsWith("fc") || info.address.startsWith("fd")) {
              if (!uniqueLocalIpv6Info) {
                uniqueLocalIpv6Info = info;
              }
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
        continue;
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

      interfaces.set(name, networkInterface);
    }

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

  private static async getNetworkInterfaceNames(): Promise<InterfaceName[]> {
    // this function will always include the loopback interface

    let promise: Promise<InterfaceName[]>;
    switch (os.platform()) {
      case "win32":
        promise = NetworkManager.getWindowsNetworkInterfaces();
        break;
      case "linux": {
        promise = NetworkManager.getLinuxNetworkInterfaces();
        break;
      }
      case "darwin":
        promise = NetworkManager.getDarwinNetworkInterfaces();
        break;
      case "freebsd": {
        promise = NetworkManager.getFreeBSDNetworkInterfaces();
        break;
      }
      case "openbsd":
      case "sunos": {
        promise = NetworkManager.getOpenBSD_SUNOS_NetworkInterfaces();
        break;
      }
      default:
        debug("Found unsupported platform %s", os.platform());
        return Promise.reject(new Error("unsupported platform!"));
    }

    const names = await promise;
    const loopback = NetworkManager.getLoopbackInterface();

    if (!names.includes(loopback)) {
      names.unshift(loopback);
    }

    return promise;
  }

  private static assumeNetworkInterfaceNames(): InterfaceName[] {
    // this method is a fallback trying to calculate network related interfaces in an platform independent way

    const names: InterfaceName[] = [];
    Object.entries(os.networkInterfaces()).forEach(([name, infos]) => {
      for (const info of infos) {
        // we add the loopback interface or interfaces which got a unique (global or local) ipv6 address
        // we currently don't just add all interfaces with ipv4 addresses as are often interfaces like VPNs, container/vms related

        // unique global or unique local ipv6 addresses give an indication that we are truly connected to "the Internet"
        // as something like SLAAC must be going on
        // in the end
        if (info.internal || info.family === "IPv4" || info.family === "IPv6" && info.scopeid === 0) {
          if (!names.includes(name)) {
            names.push(name);
          }
          break;
        }
      }
    });

    return names;
  }

  private static getLoopbackInterface(): InterfaceName {
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      for (const info of infos) {
        if (info.internal) {
          return name;
        }
      }
    }

    throw new Error("Could not detect loopback interface!");
  }

  private static getWindowsNetworkInterfaces(): Promise<InterfaceName[]> {
    // does not return loopback interface
    return new Promise((resolve, reject) => {
      childProcess.exec("arp -a | findstr /C:\"---\"", (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const lines = stdout.split(os.EOL);

        const addresses: IPv4Address[] = [];
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim().split(" ");

          if (line[line.length - 3]) {
            addresses.push(line[line.length - 3]);
          } else {
            debug(`WINDOWS: Failed to read interface name from line ${i}: '${lines[i]}'`);
          }
        }

        const names: InterfaceName[] = [];
        for (const address of addresses) {
          const name = NetworkManager.resolveInterface(address);
          if (name) {
            if (!names.includes(name)) {
              names.push(name);
            }
          } else {
            debug(`WINDOWS: Couldn't resolve to an interface name from '${address}'`);
          }
        }

        if (names.length) {
          resolve(names);
        } else {
          reject(new Error("WINDOWS: No interfaces were found!"));
        }
      });
    });
  }

  private static getDarwinNetworkInterfaces(): Promise<InterfaceName[]> {
    /*
     * Previous efforts used the routing table to get all relevant network interfaces.
     * Particularly using "netstat -r -f inet -n".
     * First attempt was to use the "default" interface to the 0.0.0.0 catch all route using "route get 0.0.0.0".
     * Though this fails when the router isn't connected to the internet, thus no "internet route" exists.
     */

    // does not return loopback interface
    return new Promise((resolve, reject) => {
      // for ipv6 "ndp -a -n |grep -v permanent" with filtering for "expired"
      childProcess.exec("arp -a -n -l", async (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const lines = stdout.split(os.EOL);
        const names: InterfaceName[] = [];

        for (let i = 1; i < lines.length - 1; i++) {
          const interfaceName = lines[i].trim().split(NetworkManager.SPACE_PATTERN)[4];
          if (!interfaceName) {
            debug(`DARWIN: Failed to read interface name from line ${i}: '${lines[i]}'`);
            continue;
          }

          if (!names.includes(interfaceName)) {
            names.push(interfaceName);
          }
        }

        const promises: Promise<void>[] = [];
        for (const name of names) {
          const promise = NetworkManager.getDarwinWifiNetworkState(name).then(state => {
            if (state !== WifiState.NOT_A_WIFI_INTERFACE && state !== WifiState.CONNECTED) {
              // removing wifi networks which are not connected to any networks
              const index = names.indexOf(name);
              if (index !== -1) {
                names.splice(index, 1);
              }
            }
          });

          promises.push(promise);
        }

        await Promise.all(promises);

        if (names.length) {
          resolve(names);
        } else {
          reject(new Error("DARWIN: No interfaces were found!"));
        }
      });
    });
  }

  private static getLinuxNetworkInterfaces(): Promise<InterfaceName[]> {
    // does not return loopback interface
    return new Promise((resolve, reject) => {
      // we use "ip neigh" here instead of the aliases like "ip neighbour" or "ip neighbor"
      // as those were only added like 5 years ago https://github.com/shemminger/iproute2/commit/ede723964a065992bf9d0dbe3f780e65ca917872
      childProcess.exec("ip neigh show", (error, stdout) => {
        if (error) {
          if (error.message.includes("ip: not found")) {
            debug("LINUX: ip was not found on the system. Falling back to assuming network interfaces!");
            resolve(NetworkManager.assumeNetworkInterfaceNames());
            return;
          }

          reject(error);
          return;
        }

        const lines = stdout.split(os.EOL);
        const names: InterfaceName[] = [];

        for (let i = 0; i < lines.length - 1; i++) {
          const parts = lines[i].trim().split(NetworkManager.SPACE_PATTERN);

          let devIndex = 0;
          for (; devIndex < parts.length; devIndex++) {
            if (parts[devIndex] === "dev") {
              // the next index marks the interface name
              break;
            }
          }

          if (devIndex >= parts.length) {
            debug(`LINUX: Out of bounds when reading interface name from line ${i}: '${lines[i]}'`);
            continue;
          }

          const interfaceName = parts[devIndex + 1];
          if (!interfaceName) {
            debug(`LINUX: Failed to read interface name from line ${i}: '${lines[i]}'`);
            continue;
          }

          if (!names.includes(interfaceName)) {
            names.push(interfaceName);
          }
        }

        if (names.length) {
          resolve(names);
        } else {
          reject(new Error("LINUX: No interfaces were found!"));
        }
      });
    });
  }

  private static getFreeBSDNetworkInterfaces(): Promise<InterfaceName[]> {
    // does not return loopback interface
    return new Promise((resolve, reject) => {
      childProcess.exec("arp -a -n", (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const lines = stdout.split(os.EOL);
        const names: InterfaceName[] = [];


        for (let i = 0; i < lines.length - 1; i++) {
          const interfaceName = lines[i].trim().split(NetworkManager.SPACE_PATTERN)[5];
          if (!interfaceName) {
            debug(`FreeBSD: Failed to read interface name from line ${i}: '${lines[i]}'`);
            continue;
          }

          if (!names.includes(interfaceName)) {
            names.push(interfaceName);
          }
        }

        if (names.length) {
          resolve(names);
        } else {
          reject(new Error("FreeBSD: No interfaces were found!"));
        }
      });
    });
  }

  private static getOpenBSD_SUNOS_NetworkInterfaces(): Promise<InterfaceName[]> {
    // does not return loopback interface
    return new Promise((resolve, reject) => {
      // for ipv6 something like "ndp -a -n | grep R" (grep for reachable; maybe exclude permanent?)
      childProcess.exec("arp -a -n", (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const lines = stdout.split(os.EOL);
        const names: InterfaceName[] = [];

        for (let i = 1; i < lines.length - 1; i++) {
          const interfaceName = lines[i].trim().split(NetworkManager.SPACE_PATTERN)[2];
          if (!interfaceName) {
            debug(`${os.platform()}: Failed to read interface name from line ${i}: '${lines[i]}'`);
            continue;
          }

          if (!names.includes(interfaceName)) {
            names.push(interfaceName);
          }
        }

        if (names.length) {
          resolve(names);
        } else {
          reject(new Error(os.platform().toUpperCase() + ": No interfaces were found!"));
        }
      });
    });
  }

  private static getDarwinWifiNetworkState(name: InterfaceName): Promise<WifiState> {
    return new Promise(resolve => {
      /*
         * networksetup outputs the following in the listed scenarios:
         *
         * executed for an interface which is not a Wi-Fi interface:
         * "<name> is not a Wi-Fi interface.
         * Error: Error obtaining wireless information."
         *
         * executed for a turned off Wi-Fi interface:
         * "You are not associated with an AirPort network.
         * Wi-Fi power is currently off."
         *
         * executed for a turned on Wi-Fi interface which is not connected:
         * "You are not associated with an AirPort network."
         *
         * executed for a connected Wi-Fi interface:
         * "Current Wi-Fi Network: <network name>"
         */
      childProcess.exec("networksetup -getairportnetwork " + name, (error, stdout) => {
        if (error) {
          if (stdout.includes("not a Wi-Fi interface")) {
            resolve(WifiState.NOT_A_WIFI_INTERFACE);
            return;
          }

          console.log(`CIAO WARN: While checking networksetup for ${name} encountered an error (${error.message}) with output: ${stdout.replace(os.EOL, "; ")}`);
          resolve(WifiState.UNDEFINED);
          return;
        }

        let wifiState = WifiState.UNDEFINED;
        if (stdout.includes("not a Wi-Fi interface")) {
          wifiState = WifiState.NOT_A_WIFI_INTERFACE;
        } else if (stdout.includes("Current Wi-Fi Network")) {
          wifiState = WifiState.CONNECTED;
        } else if (stdout.includes("not associated")) {
          wifiState = WifiState.NOT_ASSOCIATED;
        } else {
          console.log(`CIAO WARN: While checking networksetup for ${name} encountered an unknown output: ${stdout.replace(os.EOL, "; ")}`);
        }

        resolve(wifiState);
      });
    });
  }

}
