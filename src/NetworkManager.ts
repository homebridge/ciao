import os, { NetworkInterfaceInfo } from "os";
import * as systemInformation from "systeminformation";
import { EventEmitter } from "events";
import assert from "assert";
import crypto from "crypto";

export interface NetworkInterface {
  name: string;
  mac: string;

  // one of ipv4 or ipv6 will be present, most of the time even both
  ipv4?: string;
  ipv4Subnet?: string;
  ipv6?: string;
  ipv6Subnet?: string;
}


export const enum NetworkManagerEvent {
  INTERFACE_UPDATE = "interface-update",
  DEFAULT_INTERFACE_UPDATE = "default-update",
}

export interface NetworkChange {
  added?: NetworkInterface[];
  removed?: NetworkInterface[];
  updated?: NetworkInterface[]; // ip change
}

export declare interface NetworkManager {

  on(event: "interface-update", listener: (change: NetworkChange) => void): this;
  on(event: "default-update", listener: (interfaceName: string) => void): this;

  emit(event: "interface-update", change: NetworkChange): boolean;
  emit(event: "default-update", interfaceName: string): boolean;

}

export class NetworkManager extends EventEmitter {

  private static readonly POLLING_TIME = 5 * 1000; // 5 seconds
  private static readonly DEFAULT_INTERFACE_REFRESH = (60 * 60 * 1000) / NetworkManager.POLLING_TIME;


  private readonly currentInterfaces: Map<string, NetworkInterface>;
  private readonly interfaceConfigurationHash: Map<string, string> = new Map();

  private defaultNetworkInterface = "";
  private currentDefaultNetworkInterfaceQuery?: Promise<void>;

  private refreshCounter = 0;

  constructor() {
    super();
    this.currentInterfaces = NetworkManager.getCurrentNetworkInterfaces();

    for (const [name, networkInterface] of NetworkManager.getCurrentNetworkInterfaces()) {
      this.interfaceConfigurationHash.set(name, NetworkManager.hashInterface(networkInterface));
    }

    this.queryDefaultNetworkInterface().then(() => this.scheduleNextJob());
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

  public getDefaultNetworkInterface(): string {
    return this.defaultNetworkInterface;
  }

  public waitForDefaultNetworkInterface(): Promise<void> {
    return this.currentDefaultNetworkInterfaceQuery || Promise.resolve();
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

    if (added || removed || this.refreshCounter > NetworkManager.DEFAULT_INTERFACE_REFRESH) {
      // we refresh the default interface if any got added or removed OR every hour (just in case for config changes)
      // querying the default interface takes about 10-30ms
      this.queryDefaultNetworkInterface().then(() => this.scheduleNextJob());
    } else {
      this.scheduleNextJob();
    }
  }

  private queryDefaultNetworkInterface(): Promise<void> {
    return this.currentDefaultNetworkInterfaceQuery = systemInformation.networkInterfaceDefault().then(name => {
      const emit = this.defaultNetworkInterface !== name;

      this.defaultNetworkInterface = name;
      this.currentDefaultNetworkInterfaceQuery = undefined;

      if (emit) {
        this.emit(NetworkManagerEvent.DEFAULT_INTERFACE_UPDATE, this.defaultNetworkInterface);
      }
    });
  }

  private static getCurrentNetworkInterfaces(): Map<string, NetworkInterface> {
    const interfaces: Map<string, NetworkInterface> = new Map();

    Object.entries(os.networkInterfaces()).forEach(([name, infoArray]) => {
      if (!this.validNetworkInterfaceName(name)) {
        return;
      }

      let ipv4Info: NetworkInterfaceInfo | undefined = undefined;
      let ipv6Info: NetworkInterfaceInfo | undefined = undefined;
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
        ipv4Subnet: ipv4Info?.netmask,

        ipv6: ipv6Info?.address,
        ipv6Subnet: ipv6Info?.netmask,
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
