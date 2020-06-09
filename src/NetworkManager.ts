import assert from "assert";
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

export interface NetworkInterface {
  name: InterfaceName;
  mac: MacAddress;

  // one of ipv4 or ipv6 will be present, most of the time even both
  ipv4?: IPv4Address;
  ipv4NetAddress?: IPv4Address; // address identifying the address for the ipv4 net
  ipv6?: IPv6Address;
  ipv6NetAddress?: IPv6Address; // address identifying the address for the ipv6 net

  routeAbleIpv6?: IPv6Address[];
}

export interface NetworkInformation {
  netAddress: IPAddress;
  interfaces: string[];
}

export const enum NetworkManagerEvent {
  INTERFACE_UPDATE = "interface-update",
}

export interface NetworkChange {
  added?: NetworkInterface[];
  removed?: NetworkInterface[];
  updated?: InterfaceChange[];
}

export interface InterfaceChange {
  outdatedAddresses: IPAddress[];
  updatedAddresses: IPAddress[];

  oldInterface: NetworkInterface;
  newInterface: NetworkInterface;
}

export interface NetworkManagerOptions {
  interface?: string | string[];
  excludeIpv6Only?: boolean;
}

export declare interface NetworkManager {

  on(event: "interface-update", listener: (change: NetworkChange) => void): this;

  emit(event: "interface-update", change: NetworkChange): boolean;

}

export class NetworkManager extends EventEmitter {

  private static readonly POLLING_TIME = 15 * 1000; // 15 seconds

  private readonly restrictedInterfaces?: InterfaceName[];
  private readonly excludeIpv6Only: boolean;

  private readonly networks: Map<IPAddress, NetworkInformation> = new Map(); // indexed by netaddress
  private readonly currentInterfaces: Map<InterfaceName, NetworkInterface> = new Map();

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

    this.checkForNewInterfaces();

    const networks: string[] = [];
    for (const network of this.networks.values()) {
      networks.push(`{ '${network.netAddress}' => [${network.interfaces.join(", ")}]}`);
    }

    if (options) {
      debug("Created NetworkManager (initial interfaces [%s]; options: %s)", networks.join(", "), JSON.stringify(options));
    } else {
      debug("Created NetworkManager (initial interfaces [%s])", networks.join(", "));
    }
  }

  public shutdown(): void {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
  }

  public getNetworkMap(): Map<IPAddress, NetworkInformation> {
    return this.networks;
  }

  public getNetwork(netAddress: IPAddress): NetworkInformation | undefined {
    return this.networks.get(netAddress);
  }

  public getInterfaceMap(): Map<InterfaceName, NetworkInterface> {
    return this.currentInterfaces;
  }

  public getInterfaces(): IterableIterator<NetworkInterface> {
    return this.currentInterfaces.values();
  }

  public getInterface(name: InterfaceName): NetworkInterface | undefined {
    return this.currentInterfaces.get(name);
  }

  private scheduleNextJob(): void {
    const timer = setTimeout(this.checkForNewInterfaces.bind(this), NetworkManager.POLLING_TIME);
    timer.unref(); // this timer won't prevent shutdown
  }

  private checkForNewInterfaces(): void {
    debug("Checking for new interfaces...");

    const latestInterfaces = this.getCurrentNetworkInterfaces();

    let added: NetworkInterface[] | undefined = undefined;
    let removed: NetworkInterface[] | undefined = undefined;
    let updated: InterfaceChange[] | undefined = undefined;

    for (const networkInterface of latestInterfaces.values()) {
      const name = networkInterface.name;
      const currentInterface = this.currentInterfaces.get(name);

      if (currentInterface) {
        // check if interface was updated
        if (!deepEqual(currentInterface, networkInterface)) {
          const outdatedAddresses: string[] = [];
          const newAddresses: string[] = [];

          if (currentInterface.ipv4 !== networkInterface.ipv4) { // check for changed ipv4
            if (currentInterface.ipv4) {
              if (!networkInterface.ipv4) { // the ipv4 address disappeared
                assert(currentInterface.ipv4NetAddress, "Encountered illegal state. Net address not found for ipv4 address");
                this.removeNetworkIfPresent(currentInterface.ipv4NetAddress!, name);
              }

              outdatedAddresses.push(currentInterface.ipv4);
            }
            if (networkInterface.ipv4) {
              if (!currentInterface.ipv4) { // an ipv4 address appeared where previously there wasn't any
                assert(currentInterface.ipv4NetAddress, "Encountered illegal state. Net address not found for ipv4 address");
                this.addNetworkIfNotPresent(networkInterface.ipv4NetAddress!, name);
              }

              newAddresses.push(networkInterface.ipv4);
            }
          }

          if (currentInterface.ipv6 !== networkInterface.ipv6) { // check for changed ipv6
            if (currentInterface.ipv6) {
              if (!networkInterface.ipv6) { // the ipv6 address disappeared
                assert(currentInterface.ipv6NetAddress, "Encountered illegal state. Net address not found for ipv6 address");
                this.removeNetworkIfPresent(currentInterface.ipv6NetAddress!, name);
              }

              outdatedAddresses.push(currentInterface.ipv6);
            }
            if (networkInterface.ipv6) {
              if (!currentInterface.ipv6) { // an ipv6 address appeared where previously there wasn't any
                assert(currentInterface.ipv6NetAddress, "Encountered illegal state. Net address not found for ipv46address");
                this.addNetworkIfNotPresent(networkInterface.ipv6NetAddress!, name);
              }

              newAddresses.push(networkInterface.ipv6);
            }
          }

          if (!deepEqual(currentInterface.routeAbleIpv6, networkInterface.routeAbleIpv6)) {
            const oldRoutable = currentInterface.routeAbleIpv6 || [];
            const newRoutable = networkInterface.routeAbleIpv6 || [];

            for (const address of oldRoutable) {
              if (!newRoutable.includes(address)) {
                outdatedAddresses.push(address);
              }
            }

            for (const address of newAddresses) {
              if (!oldRoutable.includes(address)) {
                newAddresses.push(address);
              }
            }
          }

          (updated || (updated = [])) // get or create new array
            .push({
              newInterface: networkInterface,
              oldInterface: currentInterface,
              outdatedAddresses: outdatedAddresses,
              updatedAddresses: newAddresses,
            });

          this.currentInterfaces.set(name, networkInterface);
        }
      } else { // new interface was added/started
        (added || (added = [])) // get or create new array
          .push(networkInterface);

        this.currentInterfaces.set(name, networkInterface);

        if (networkInterface.ipv4NetAddress) {
          this.addNetworkIfNotPresent(networkInterface.ipv4NetAddress, networkInterface.name);
        }
        if (networkInterface.ipv6NetAddress) {
          this.addNetworkIfNotPresent(networkInterface.ipv6NetAddress, networkInterface.name);
        }
      }
    }

    // at this point we updated any existing interfaces and added all new interfaces
    // thus if the length of below is not the same interface must have been removed
    // this check ensures that we do not unnecessarily loop twice through our interfaces
    if (this.currentInterfaces.size !== latestInterfaces.size) {
      for (const [name, networkInterface] of this.currentInterfaces) {
        if (!latestInterfaces.has(name)) {
          (removed || (removed = [])) // get or create new array
            .push(networkInterface);

          this.currentInterfaces.delete(name);
          if (networkInterface.ipv4NetAddress) {
            this.removeNetworkIfPresent(networkInterface.ipv4NetAddress, name);
          }
          if (networkInterface.ipv6NetAddress) {
            this.removeNetworkIfPresent(networkInterface.ipv6NetAddress, name);
          }
        }
      }
    }

    if (added || removed || updated) { // emit an event if changes happened
      debug("Detected network changes: %d added, %d removed, %d updated",
        added?.length || 0, removed?.length || 0, updated?.length || 0);

      this.emit(NetworkManagerEvent.INTERFACE_UPDATE, {
        added: added,
        removed: removed,
        updated: updated,
      });
    }

    this.scheduleNextJob();
  }

  private getCurrentNetworkInterfaces(): Map<InterfaceName, NetworkInterface> {
    const interfaces: Map<InterfaceName, NetworkInterface> = new Map();

    Object.entries(os.networkInterfaces()).forEach(([name, infoArray]) => {
      if (!NetworkManager.validNetworkInterfaceName(name)) {
        return;
      }

      if (this.restrictedInterfaces && !this.restrictedInterfaces.includes(name)) {
        return;
      }

      let ipv4Info: NetworkInterfaceInfo | undefined = undefined;
      let ipv6Info: NetworkInterfaceInfo | undefined = undefined;
      let routableIpv6Infos: IPv6Address[] | undefined = undefined;
      let internal = false;

      for (const info of infoArray) {
        if (info.internal) {
          internal = true;
          break;
        }

        if (info.family === "IPv4" && !ipv4Info) {
          ipv4Info = info;
        } else if (info.family === "IPv6" && !ipv6Info) {
          if (info.scopeid) { // we only care about non zero scope (aka link-local ipv6)
            ipv6Info = info;
          } else if (info.scopeid === 0) { // global routable ipv6
            (routableIpv6Infos || (routableIpv6Infos = []))
              .push(info.address);
          }
        }
      }

      if (internal) {
        return; // we will not explicitly add the loopback interface
      }

      assert(ipv4Info || ipv6Info, "Could not find valid addresses for interface '" + name + "'");

      if (this.excludeIpv6Only && !ipv4Info) {
        return;
      }

      const networkInterface: NetworkInterface = {
        name: name,
        mac: (ipv4Info?.mac || ipv6Info?.mac)!,

        routeAbleIpv6: routableIpv6Infos,
      };

      if (ipv4Info) {
        networkInterface.ipv4 = ipv4Info.address;
        networkInterface.ipv4NetAddress = getNetAddress(ipv4Info.address, ipv4Info.netmask);
      }

      if (ipv6Info) {
        networkInterface.ipv6 = ipv6Info.address;
        networkInterface.ipv6NetAddress = getNetAddress(ipv6Info.address, ipv6Info.netmask);
      }

      interfaces.set(name, networkInterface);
    });

    return interfaces;
  }

  private addNetworkIfNotPresent(netAddress: IPAddress, interfaceName: string): void {
    const network = this.networks.get(netAddress);
    if (network) {
      if (!network.interfaces.includes(interfaceName)) {
        network.interfaces.push(interfaceName);
      }
    } else {
      this.networks.set(netAddress, {
        netAddress: netAddress,
        interfaces: [interfaceName],
      });
    }
  }

  private removeNetworkIfPresent(netAddress: IPAddress, interfaceName: string): void {
    const network = this.networks.get(netAddress);

    if (network) {
      const index = network.interfaces.indexOf(interfaceName);
      if (index >= 0) {
        network.interfaces.splice(index, 1);

        if (network.interfaces.length === 0) {
          this.networks.delete(netAddress);
        }
      }
    }
  }

  private static validNetworkInterfaceName(name: InterfaceName): boolean {
    // TODO are these all the available names?
    return os.platform() === "win32" // windows has some weird interface naming, just pass everything for now
      || name.startsWith("en") || name.startsWith("eth") || name.startsWith("wlan") || name.startsWith("wl");
  }

  private static resolveInterface(address: IPAddress): InterfaceName | undefined {
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

}
