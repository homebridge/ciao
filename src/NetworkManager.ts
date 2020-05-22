import assert from "assert";
import crypto from "crypto";
import { EventEmitter } from "events";
import os, { NetworkInterfaceInfo } from "os";

export interface NetworkInterface {
  name: string;
  mac: string;

  // one of ipv4 or ipv6 will be present, most of the time even both
  ipv4?: string;
  ipv4Netmask?: string;
  ipv6?: string;
  ipv6Netmask?: string;

  routeAbleIpv6?: NetworkAddress[];
}

export interface NetworkAddress {
  address: string;
  netmask: string;
}


export const enum NetworkManagerEvent {
  INTERFACE_UPDATE = "interface-update",
}

export interface NetworkChange {
  added?: NetworkInterface[];
  removed?: NetworkInterface[];
  updated?: NetworkInterface[]; // ip change
}

export declare interface NetworkManager {

  on(event: "interface-update", listener: (change: NetworkChange) => void): this;

  emit(event: "interface-update", change: NetworkChange): boolean;

}

export class NetworkManager extends EventEmitter {

  private static readonly POLLING_TIME = 5 * 1000; // 5 seconds

  private readonly currentInterfaces: Map<string, NetworkInterface>;
  private readonly interfaceConfigurationHash: Map<string, string> = new Map();

  private refreshCounter = 0;

  constructor() {
    super();
    this.currentInterfaces = NetworkManager.getCurrentNetworkInterfaces();

    for (const [name, networkInterface] of NetworkManager.getCurrentNetworkInterfaces()) {
      this.interfaceConfigurationHash.set(name, NetworkManager.hashInterface(networkInterface));
    }
  }

  public getInterfaceMap(): Map<string, NetworkInterface> {
    return this.currentInterfaces;
  }

  public getInterfaces(): IterableIterator<NetworkInterface> {
    return this.currentInterfaces.values();
  }

  public getInterface(name: string): NetworkInterface | undefined {
    return this.currentInterfaces.get(name);
  }

  private scheduleNextJob(): void {
    const timer = setTimeout(this.checkForNewInterfaces.bind(this), NetworkManager.POLLING_TIME);
    timer.unref(); // this timer won't prevent shutdown
  }

  private checkForNewInterfaces(): void {
    this.refreshCounter++;

    const latestInterfaces = NetworkManager.getCurrentNetworkInterfaces();

    let added: NetworkInterface[] | undefined = undefined;
    let removed: NetworkInterface[] | undefined = undefined;
    let updated: NetworkInterface[] | undefined = undefined;

    for (const networkInterface of latestInterfaces.values()) {
      const name = networkInterface.name;
      const configurationHash = NetworkManager.hashInterface(networkInterface);

      if (this.currentInterfaces.has(name)) {
        // check if interface was updated
        if (configurationHash !== this.interfaceConfigurationHash.get(name)) {
          (updated || (updated = [])) // get or create new array
            .push(networkInterface);

          this.currentInterfaces.set(name, networkInterface);
          this.interfaceConfigurationHash.set(name, configurationHash);
        }
      } else { // new interface was added/started
        (added || (added = [])) // get or create new array
          .push(networkInterface);

        this.currentInterfaces.set(name, networkInterface);
        this.interfaceConfigurationHash.set(name, configurationHash);
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
          this.interfaceConfigurationHash.delete(name);
        }
      }
    }

    if (added || removed || updated) { // emit an event if changes happened
      this.emit(NetworkManagerEvent.INTERFACE_UPDATE, {
        added: added,
        removed: removed,
        updated: updated,
      });
    }

    this.scheduleNextJob();
  }

  private static getCurrentNetworkInterfaces(): Map<string, NetworkInterface> {
    const interfaces: Map<string, NetworkInterface> = new Map();

    Object.entries(os.networkInterfaces()).forEach(([name, infoArray]) => {
      if (!this.validNetworkInterfaceName(name)) {
        return;
      }

      let ipv4Info: NetworkInterfaceInfo | undefined = undefined;
      let ipv6Info: NetworkInterfaceInfo | undefined = undefined;
      let routableIpv6Infos: NetworkAddress[] | undefined = undefined;
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
            (routableIpv6Infos || (routableIpv6Infos = [])).push({
              address: info.address,
              netmask: info.netmask,
            });
          }
        }

        if (ipv4Info && ipv6Info) { // we got everything
          break;
        }
      }

      if (internal) {
        return; // we will not explicitly add the loopback interface
      }

      assert(ipv4Info || ipv6Info, "Could not find valid addresses for interface '" + name + "'");
      interfaces.set(name, {
        name: name,
        mac: (ipv4Info?.mac || ipv6Info?.mac)!,

        ipv4: ipv4Info?.address,
        ipv4Netmask: ipv4Info?.netmask,

        ipv6: ipv6Info?.address,
        ipv6Netmask: ipv6Info?.netmask,

        routeAbleIpv6: routableIpv6Infos,
      });
    });

    return interfaces;
  }

  private static validNetworkInterfaceName(name: string): boolean {
    // TODO are these all the available names?
    return os.platform() === "win32" // windows has some weird interface naming, just pass everything for now
      || name.startsWith("en") || name.startsWith("eth") || name.startsWith("wlan") || name.startsWith("wl");
  }

  private static hashInterface(networkInterface: NetworkInterface): string {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify(networkInterface));
    return hash.digest("hex");
  }

}
