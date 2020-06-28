import assert from "assert";
import createDebug from "debug";
import { EventEmitter } from "events";
import deepEqual from "fast-deep-equal";
import net from "net";
import os, { NetworkInterfaceInfo } from "os";
import { arrayDifference } from "./util/array-utils";
import { getNetAddress } from "./util/domain-formatter";
import Timeout = NodeJS.Timeout;

const debug = createDebug("ciao:NetworkManager");

export type NetworkId = string; // currently we identify the network by its ipv4 net address
export type InterfaceName = string;
export type MacAddress = string;

export type IPv4Address = string;
export type IPv6Address = string;
export type IPAddress = IPv4Address | IPv6Address;

interface NetworkInterface {
  name: InterfaceName;
  mac: MacAddress;

  // one of ipv4 or ipv6 will be present, most of the time even both
  ipv4?: IPv4Address;
  ipv4NetAddress?: IPv4Address; // address identifying the address for the ipv4 net
  ipv6?: IPv6Address;
  ipv6NetAddress?: IPv6Address; // address identifying the address for the ipv6 net

  routableIpv6?: IPv6Address[];
}

export const enum NetworkManagerEvent {
  NETWORK_UPDATE = "network-update",
}

export interface NetworkUpdate {
  added?: NetworkInformation[];
  removed?: NetworkInformation[];
  updated?: NetworkChange[];
}

export interface NetworkChange {
  networkId: NetworkId;

  removedInterfaces: InterfaceName[];
  addedInterfaces: InterfaceName[];

  changedDefaultIPv4Address?: IPv4Address;

  removedAddresses: IPAddress[];
  newAddresses: IPAddress[];
}

export interface NetworkManagerOptions {
  interface?: string | string[];
  excludeIpv6Only?: boolean;
}

export declare interface NetworkManager {

  on(event: "network-update", listener: (change: NetworkUpdate) => void): this;

  emit(event: "network-update", change: NetworkUpdate): boolean;

}

export class NetworkManager extends EventEmitter { // TODO migrate to a singleton design

  // TODO netaddresses can be the same for a different subnet mask

  private static readonly POLLING_TIME = 15 * 1000; // 15 seconds

  private readonly restrictedInterfaces?: InterfaceName[];
  private readonly excludeIpv6Only: boolean;

  private readonly participatingNetworks: Map<NetworkId, NetworkInformation>;

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
    assert(this.excludeIpv6Only, "NetworkManager currently does not support including ipv6 only networks");

    this.participatingNetworks = this.getCurrentNetworkInformation();

    const networks: string[] = [];
    for (const network of this.participatingNetworks.values()) {
      networks.push(`[${network.getInterfaceNames().join(", ")}]`);
    }

    if (options) {
      debug("Created NetworkManager (initial networks [%s]; options: %s)", networks.join(", "), JSON.stringify(options));
    } else {
      debug("Created NetworkManager (initial networks [%s])", networks.join(", "));
    }

    this.scheduleNextJob();
  }

  public shutdown(): void {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = undefined;
    }
  }

  public getNetworkMap(): Map<NetworkId, NetworkInformation> {
    return this.participatingNetworks;
  }

  public getNetworks(): IterableIterator<NetworkInformation> {
    return this.participatingNetworks.values();
  }

  public getNetworkById(id: NetworkId): NetworkInformation | undefined {
    return this.participatingNetworks.get(id);
  }

  private scheduleNextJob(): void {
    const timer = setTimeout(this.checkForNewNetworks.bind(this), NetworkManager.POLLING_TIME);
    timer.unref(); // this timer won't prevent shutdown
  }

  private checkForNewNetworks(): void {
    debug("Checking for new networks...");

    const latestNetworks = this.getCurrentNetworkInformation();

    let added: NetworkInformation[] | undefined = undefined;
    let removed: NetworkInformation[] | undefined = undefined;
    let updated: NetworkChange[] | undefined = undefined;

    for (const [name, network] of latestNetworks) {
      const currentNetwork = this.participatingNetworks.get(name);

      if (currentNetwork) { // the network could potentially have changed
        if (!currentNetwork.equals(network)) { // the network actually changed
          const change = currentNetwork.changeNetwork(network);

          (updated || (updated = [])) // get or create array
            .push(change);

          assert(currentNetwork.equals(network), "Network is still different after update!");
        }
      } else { // the network was added
        this.participatingNetworks.set(name, network);
        (added || (added = [])) // get or create array
          .push(network);
      }
    }

    // at this point we updated any existing networks and added all new networks
    // thus if the length of below is not the same, networks must have been removed completely
    // this check ensures that we do not unnecessarily loop twice through our networks
    if (this.participatingNetworks.size !== latestNetworks.size) {
      for (const [name, network] of this.participatingNetworks) {
        if (!latestNetworks.has(name)) { // network was removed
          this.participatingNetworks.delete(name);
          (removed || (removed = [])) // get or create new array
            .push(network);
        }
      }
    }

    if (added || removed || updated) { // emit an event if changes happened
      debug("Detected network changes: %d added, %d removed, %d updated",
        added?.length || 0, removed?.length || 0, updated?.length || 0);

      this.emit(NetworkManagerEvent.NETWORK_UPDATE, {
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

        routableIpv6: routableIpv6Infos,
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

  private getCurrentNetworkInformation(): Map<NetworkId, NetworkInformation> {
    const networks: Map<NetworkId, NetworkInformation> = new Map();

    const interfaces = this.getCurrentNetworkInterfaces();

    for (const networkInterface of interfaces.values()) {
      if (!networkInterface.ipv4NetAddress || !networkInterface.ipv4) { // the ipv4 check is only that Typescript also knows
        /**
         * First of all, the MDNSServer does currently only advertise on ipv4, meaning ipv6 only
         * interfaces won't ever get advertised.
         * Secondly we currently ignore the ipv6 subnet address. When adding ipv6 support to the MDNSServer
         * one might need to rework this part here.
         * If two network interfaces share the same ipv4 subnet it does not necessarily mean that they share
         * the same ipv6 subnet.
         * Though keep in mind we return all ipv6 addresses when a query arrives on the ipv4 of a network interface.
         */
        continue;
      }

      const existingNetwork = networks.get(networkInterface.ipv4NetAddress); // we currently only compare ipv4 net address

      if (existingNetwork) {
        if (!existingNetwork.hasInterface(networkInterface)) {
          existingNetwork.addInterface(networkInterface);
        }
      } else {
        const network = new NetworkInformation(networkInterface);
        networks.set(networkInterface.ipv4NetAddress, network);
      }
    }

    return networks;
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

/**
 * All NetworkInterfaces sharing the same IPv4 netAddress will be grouped into one network.
 * Most of the time, if the ipv4 netaddress match the ipv6 netaddress will also match,
 * though this is not guaranteed, tough we currently ignore that,
 * as our MDNSServer implementation does only listen on tcp4 and not tcp6.
 * Additionally when a client requests all A and AAAA records we will always return
 * the ipv6 addresses of the interface the request came on, even though we can't verify if
 * the ipv6 address may not match.
 */
export class NetworkInformation {

  private interfaces: InterfaceName[]; // most of the time this will have a length of 1

  private ipv4: IPv4Address[]; // one ipv4 for every network interface
  private readonly ipv4NetAddress: IPv4Address; // one ipv6 for every network interface
  private ipv6?: IPv6Address[];
  //ip6NetAddress?: IPv6Address; // address identifying the address for the ipv6 net
  private routableIpv6?: IPv6Address[];

  private defaultIPv4Address: IPv4Address = "";

  constructor(networkInterface: NetworkInterface) {
    assert(networkInterface.ipv4, "Can't create Network without ipv4 (currently)");
    assert(networkInterface.ipv4NetAddress, "Can't create Network without ipv4 (currently)");

    // we currently do not keep track of the mac addresses of the network interfaces, as there is no use to this

    this.interfaces = [networkInterface.name];
    this.ipv4 = [networkInterface.ipv4!];
    this.ipv4NetAddress = networkInterface.ipv4NetAddress!;

    if (networkInterface.ipv6) {
      this.ipv6 = [networkInterface.ipv6];
    }

    if (networkInterface.routableIpv6) {
      this.routableIpv6 = [];
      this.routableIpv6.push(...networkInterface.routableIpv6);
    }

    this.getDefaultIPv4(); // ensure it is set
  }

  public getId(): NetworkId {
    return this.ipv4NetAddress;
  }

  public getIPv4Addresses(): IPv4Address[] {
    return this.ipv4;
  }

  public getIPv6Addresses(): IPv6Address[] {
    return this.ipv6 || [];
  }

  public hasAddress(address: IPAddress): boolean {
    return this.ipv4.includes(address) || (!!this.ipv6 && this.ipv6.includes(address)) || (!!this.routableIpv6 && this.routableIpv6.includes(address));
  }

  // noinspection JSUnusedGlobalSymbols
  public getRoutableIPv6Addresses(): IPv6Address[] {
    return this.routableIpv6 || [];
  }

  public getAddresses(): IPAddress[] {
    const addresses = this.ipv4.concat(this.ipv6? this.ipv6: []);
    if (this.routableIpv6) {
      addresses.push(...this.routableIpv6);
    }

    return addresses;
  }

  public getDefaultIPv4(): IPv4Address {
    if (this.defaultIPv4Address) {
      return this.defaultIPv4Address;
    }
    // basically just returns the first ipv4. This is used to bind the socket on for all interfaces on the network

    this.defaultIPv4Address = this.ipv4[0];
    assert(!!this.defaultIPv4Address, "default ipv4 is undefined!");
    return this.defaultIPv4Address;
  }

  // noinspection JSUnusedGlobalSymbols
  public hasInterface(name: InterfaceName): boolean;
  public hasInterface(name: NetworkInterface): boolean;
  public hasInterface(name: InterfaceName | NetworkInterface): boolean {
    if (typeof name === "string") {
      return this.interfaces.includes(name);
    } else {
      return this.interfaces.includes(name.name);
    }
  }

  public getInterfaceNames(): InterfaceName[] {
    return this.interfaces;
  }

  public addInterface(networkInterface: NetworkInterface): void {
    assert(this.ipv4NetAddress === networkInterface.ipv4NetAddress, "Cannot add a network interface to the network with a different net address");
    this.interfaces.push(networkInterface.name);

    if (networkInterface.ipv4) {
      this.ipv4.push(networkInterface.ipv4);
    }

    if (networkInterface.ipv6) {
      if (!this.ipv6) {
        this.ipv6 = [];
      }
      this.ipv6.push(networkInterface.ipv6);
    }

    if (networkInterface.routableIpv6) {
      if (!this.routableIpv6) {
        this.routableIpv6 = [];
      }
      this.routableIpv6.push(...networkInterface.routableIpv6);
    }
  }

  public changeNetwork(updated: NetworkInformation): NetworkChange {
    const interfaceDifference = arrayDifference(this.interfaces, updated.interfaces);
    const ipv4Difference = arrayDifference(this.ipv4, updated.ipv4);
    const ipv6Difference = arrayDifference(this.ipv6, updated.ipv6);
    const routableDifference = arrayDifference(this.routableIpv6, updated.routableIpv6);

    const oldDefaultIpv4 = this.getDefaultIPv4();

    const addedAddresses = ipv4Difference.added.concat(ipv6Difference.added).concat(routableDifference.added);
    const removedAddresses = ipv4Difference.removed.concat(ipv6Difference.removed).concat(routableDifference.removed);

    // preserve a predictable order
    this.interfaces = updated.interfaces;
    this.ipv4 = updated.ipv4;
    this.ipv6 = updated.ipv6;
    this.routableIpv6 = updated.routableIpv6;

    if (!this.hasAddress(oldDefaultIpv4)) {
      this.defaultIPv4Address = ""; // reset the default ip, it disappeared
      // calling getDefaultIPv4 again (like below) will set it to a new default again
    }

    return {
      networkId: this.ipv4NetAddress,

      addedInterfaces: interfaceDifference.added,
      removedInterfaces: interfaceDifference.removed,

      changedDefaultIPv4Address: oldDefaultIpv4 !== this.getDefaultIPv4()? this.getDefaultIPv4(): undefined,

      newAddresses: addedAddresses,
      removedAddresses: removedAddresses,
    };
  }

  public equals(network: NetworkInformation): boolean {
    return this.ipv4NetAddress === network.ipv4NetAddress && deepEqual(this.interfaces, network.interfaces)
      && deepEqual(this.ipv4, network.ipv4) && deepEqual(this.ipv6, network.ipv6)
      && deepEqual(this.routableIpv6, network.routableIpv6);
  }

}
