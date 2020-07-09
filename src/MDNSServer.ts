import assert from "assert";
import createDebug from "debug";
import dgram, { Socket } from "dgram";
import { AddressInfo } from "net";
import {
  DNSPacket,
  DNSProbeQueryDefinition,
  DNSQueryDefinition,
  DNSResponseDefinition,
  OpCode,
  PacketType,
  RCode,
} from "./coder/DNSPacket";
import { InterfaceName, IPFamily, NetworkManager, NetworkManagerEvent, NetworkUpdate } from "./NetworkManager";
import { getNetAddress } from "./util/domain-formatter";

const debug = createDebug("ciao:MDNSServer");

export interface EndpointInfo {
  address: string;
  port: number;
  interface: string;
}

export type SendCallback = (error?: Error | null) => void;

/**
 * Defines the options passed to the underlying mdns server.
 */
export interface MDNSServerOptions {
  /**
   * If specified, the mdns server will only listen on the specified interfaces (allowlist).
   * It can be supplied as a string (representing a single interface) or as an array of strings
   * to define multiple interfaces.
   * The interface can be defined by specifying the interface name (like 'en0') or
   * by specifying an ip address.
   */
  interface?: string | string[];
}

export interface PacketHandler {

  handleQuery(packet: DNSPacket, rinfo: EndpointInfo): void;

  handleResponse(packet: DNSPacket, rinfo: EndpointInfo): void;

}

interface SocketError {
  name: string;
  error: Error;
}

/**
 * This class can be used to create a mdns server to send and receive mdns packets on the local network.
 *
 * Currently only udp4 sockets will be advertised.
 */
export class MDNSServer {

  public static readonly MTU = process.env.CIAO_MTU? parseInt(process.env.CIAO_MTU): 1500;
  public static readonly DEFAULT_IP4_HEADER = 20;
  public static readonly DEFAULT_IP6_HEADER = 40;
  public static readonly UDP_HEADER = 8;

  public static readonly MDNS_PORT = 5353;
  public static readonly MDNS_TTL = 255;
  public static readonly MULTICAST_IPV4 = "224.0.0.251";
  public static readonly MULTICAST_IPV6 = "FF02::FB";

  private readonly handler: PacketHandler;
  private readonly networkManager: NetworkManager;

  private readonly sockets: Map<InterfaceName, Socket> = new Map();

  // RFC 6762 15.1. If we are not the first responder bound to 5353 we can't receive unicast responses
  // thus the QU flag must not be used in queries. Responders are only affected when sending probe queries.
  // Probe queries should be sent with QU set, though can't be sent with QU when we can't receive unicast responses.
  private suppressUnicastResponseFlag = false;

  private bound = false;
  private closed = false;

  constructor(handler: PacketHandler, options?: MDNSServerOptions) {
    assert(handler, "handler cannot be undefined");
    this.handler = handler;

    this.networkManager = new NetworkManager({
      interface: options && options.interface,
      excludeIpv6Only: true,
    });
    this.networkManager.on(NetworkManagerEvent.NETWORK_UPDATE, this.handleUpdatedNetworkInterfaces.bind(this));

    this.networkManager.waitForInit().then(() => {
      for (const name of this.networkManager.getInterfaceMap().keys()) {
        const multicast = this.createDgramSocket(name, true);

        this.sockets.set(name, multicast);
      }
    });
  }

  public getNetworkManager(): NetworkManager {
    return this.networkManager;
  }

  public getInterfaceNames(): IterableIterator<InterfaceName> {
    return this.networkManager.getInterfaceMap().keys();
  }

  public getNetworkCount(): number {
    return this.sockets.size;
  }

  public async bind(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot rebind closed server!");
    }

    // RFC 6762 15.1. suggest that we probe if we are not the only socket.
    // though as ciao will probably always be installed besides an existing mdns responder, we just assume that without probing
    // As it only affects probe queries, impact isn't that big.
    this.suppressUnicastResponseFlag = true;

    await this.networkManager.waitForInit();
    const promises: Promise<void>[] = [];
    for (const [name, socket] of this.sockets) {
      promises.push(this.bindSocket(socket, name, IPFamily.IPv4));
    }

    return Promise.all(promises).then(() => {
      this.bound = true;
      // map void[] to void
    });
  }

  public shutdown(): void {
    this.networkManager.shutdown();

    for (const socket of this.sockets.values()) {
      socket.close();
    }

    this.bound = false;
    this.closed = true;

    this.sockets.clear();
  }

  public sendQueryBroadcast(query: DNSQueryDefinition | DNSProbeQueryDefinition, callback?: SendCallback): void {
    const packets = DNSPacket.createDNSQueryPackets(query, MDNSServer.MTU, IPFamily.IPv4);
    if (packets.length > 1) {
      debug("Query broadcast is split into %d packets!", packets.length);
    }

    const promises: Promise<void>[] = [];
    for (const packet of packets) {
      promises.push(this.sendOnAllNetworks(packet));
    }

    Promise.all(promises).then(() => {
      if (callback) {
        callback();
      }
    }, (error: SocketError) => {
      callback? callback(error.error): MDNSServer.handleSocketError(error.name, error.error);
    });
  }

  public sendResponseBroadcast(response: DNSResponseDefinition, callback?: SendCallback): void {
    const packets = DNSPacket.createDNSResponsePackets(response, MDNSServer.MTU, IPFamily.IPv4);
    if (packets.length > 1) {
      debug("Response broadcast is split into %d packets!", packets.length);
    }

    const promises: Promise<void>[] = [];
    for (const packet of packets) {
      promises.push(this.sendOnAllNetworks(packet));
    }

    Promise.all(promises).then(() => {
      if (callback) {
        callback();
      }
    }, (error: SocketError) => {
      callback? callback(error.error): MDNSServer.handleSocketError(error.name, error.error);
    });
  }

  public sendResponse(response: DNSResponseDefinition, endpoint: EndpointInfo, callback?: SendCallback): void;
  public sendResponse(response: DNSResponseDefinition, interfaceName: InterfaceName, callback?: SendCallback): void;
  public sendResponse(response: DNSResponseDefinition, endpointOrInterface: EndpointInfo | InterfaceName, callback?: SendCallback): void {
    const packets = DNSPacket.createDNSResponsePackets(response, MDNSServer.MTU, IPFamily.IPv4);
    if (packets.length > 1) {
      debug("Response is split into %d packets!", packets.length);
    }

    const promises: Promise<void>[] = [];
    for (const packet of packets) {
      promises.push(this.send(packet, endpointOrInterface));
    }

    Promise.all(promises).then(() => {
      if (callback) {
        callback();
      }
    }, (error: SocketError) => {
      callback? callback(error.error): MDNSServer.handleSocketError(error.name, error.error);
    });
  }

  private sendOnAllNetworks(packet: DNSPacket): Promise<void> {
    this.checkUnicastResponseFlag(packet);

    const message = packet.encode();
    this.assertBeforeSend(message, IPFamily.IPv4);

    const promises: Promise<void>[] = [];
    for (const [name, socket] of this.sockets) {
      const promise = new Promise<void>((resolve, reject) => {
        socket.send(message, MDNSServer.MDNS_PORT, MDNSServer.MULTICAST_IPV4, error => {
          if (error) {
            const socketError: SocketError = { name: name, error: error };
            reject(socketError);
          } else {
            resolve();
          }
        });
      });
      promises.push(promise);
    }

    return Promise.all(promises).then(() => {
      // map void[] to void
    });
  }

  private send(packet: DNSPacket, endpointOrInterface: EndpointInfo | InterfaceName): Promise<void> {
    this.checkUnicastResponseFlag(packet);

    const message = packet.encode();
    this.assertBeforeSend(message, IPFamily.IPv4);

    let address: string;
    let port: number;
    let name: string;

    if (typeof endpointOrInterface === "string") { // its a network interface name
      address = MDNSServer.MULTICAST_IPV4;
      port = MDNSServer.MDNS_PORT;
      name = endpointOrInterface;
    } else {
      address = endpointOrInterface.address;
      port = endpointOrInterface.port;
      name = endpointOrInterface.interface;
    }

    const socket = this.sockets.get(name);
    assert(socket, `Could not find socket for given network interface '${name}'`);

    return new Promise<void>((resolve, reject) => {
      socket!.send(message, port, address, error => {
        if (error) {
          const socketError: SocketError = { name: name, error: error };
          reject(socketError);
        } else {
          resolve();
        }
      });
    });
  }

  private checkUnicastResponseFlag(packet: DNSPacket): void {
    if (this.suppressUnicastResponseFlag && packet.type === PacketType.QUERY) {
      packet.questions.forEach(record => record.unicastResponseFlag = false);
    }
  }

  private assertBeforeSend(message: Buffer, family: IPFamily): void {
    assert(this.bound, "Cannot send packets before server is not bound!");
    assert(!this.closed, "Cannot send packets on a closed mdns server!");

    const ipHeaderSize = family === IPFamily.IPv4? MDNSServer.DEFAULT_IP4_HEADER: MDNSServer.DEFAULT_IP6_HEADER;

    // RFC 6762 17.
    assert(ipHeaderSize + MDNSServer.UDP_HEADER + message.length <= 9000,
      "DNS cannot exceed the size of 9000 bytes even with IP Fragmentation!");
  }

  private createDgramSocket(name: InterfaceName, reuseAddr = false, type: "udp4" | "udp6" = "udp4"): Socket {
    const socket = dgram.createSocket({
      type: type,
      reuseAddr: reuseAddr,
    });

    socket.on("message", this.handleMessage.bind(this, name));
    socket.on("error", MDNSServer.handleSocketError.bind(this, name));

    return socket;
  }

  private bindSocket(socket: Socket, name: InterfaceName, family: IPFamily): Promise<void> {
    const networkInterface = this.networkManager.getInterface(name);
    assert(networkInterface, `Could not find network interface '${name}' in network manager which socket is going to be bind to!`);

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      socket.bind(MDNSServer.MDNS_PORT, () => {
        socket.removeListener("error", errorHandler);

        const multicastAddress = family === IPFamily.IPv4? MDNSServer.MULTICAST_IPV4: MDNSServer.MULTICAST_IPV6;
        const interfaceAddress = family === IPFamily.IPv4? networkInterface!.ipv4: networkInterface!.ipv6;
        assert(interfaceAddress, "Interface address cannot be undefined!");

        socket.addMembership(multicastAddress, interfaceAddress!);

        socket.setMulticastInterface(interfaceAddress!);

        socket.setMulticastTTL(MDNSServer.MDNS_TTL); // outgoing multicast datagrams
        socket.setTTL(MDNSServer.MDNS_TTL); // outgoing unicast datagrams

        socket.setMulticastLoopback(true);

        resolve();
      });
    });
  }

  private handleMessage(name: InterfaceName, buffer: Buffer, rinfo: AddressInfo): void {
    if (!this.bound) {
      return;
    }

    const networkInterface = this.networkManager.getInterface(name);
    if (!networkInterface) {
      debug("Received packet on non existing network interface: %s!", name);
      return;
    }
    const ip4Netaddress = getNetAddress(rinfo.address, networkInterface.ip4Netmask!);
    if (ip4Netaddress !== networkInterface.ipv4Netaddress) {
      // This isn't a problem on macOS (it seems like to respect the desired interface we supply for our membership)
      // On Linux based system such filtering seems to not happen :thinking: we just get any traffic and it's like
      // we are just bound to 0.0.0.0
      return;
    }

    let packet: DNSPacket;
    try {
      // TODO parse packet on the fly, a lot of RESPONSE packets will never be used
      packet = DNSPacket.decode(buffer);
    } catch (error) {
      debug("Received malformed packet from %s: %s", JSON.stringify(rinfo), error.message);
      debug(error.stack); // might be a bit spammy, but not having the error cause when it's maybe needed is not better
      return;
    }

    if (packet.opcode !== OpCode.QUERY) {
      // RFC 6762 18.3 we MUST ignore messages with opcodes other than zero (QUERY)
      return;
    }

    if (packet.rcode !== RCode.NoError) {
      // RFC 6762 18.3 we MUST ignore messages with response code other than zero (NoError)
      return;
    }

    const endpoint: EndpointInfo = {
      address: rinfo.address,
      port: rinfo.port,
      interface: name,
    };

    if (packet.type === PacketType.QUERY) {
      this.handler.handleQuery(packet, endpoint);
    } else if (packet.type === PacketType.RESPONSE) {
      if (rinfo.port !== MDNSServer.MDNS_PORT) {
        // RFC 6762 6.  Multicast DNS implementations MUST silently ignore any Multicast DNS responses
        //    they receive where the source UDP port is not 5353.
        return;
      }

      this.handler.handleResponse(packet, endpoint);
    }
  }

  private static handleSocketError(name: InterfaceName, error: Error): void {
    console.warn(`Encountered MDNS socket error on socket '${name}' : ${error.message}`);
    console.warn(error.stack);
  }

  private handleUpdatedNetworkInterfaces(networkUpdate: NetworkUpdate): void {
    if (networkUpdate.removed) {
      for (const networkInterface of networkUpdate.removed) {
        const socket = this.sockets.get(networkInterface.name);
        this.sockets.delete(networkInterface.name);

        if (socket) {
          socket.close();
        }
      }
    }

    if (networkUpdate.changes) {
      for (const change of networkUpdate.changes) {
        const socket = this.sockets.get(change.name);
        assert(socket, "Couldn't find socket for network change!");

        if (!change.outdatedIpv4 && change.updatedIpv4) {
          // this does currently not happen, as we exclude ipv6 only interfaces
          // thus such a change would be happening through the ADDED array
          assert.fail("Reached illegal state! IPv4 address changed from undefined to defined!");
        } else if (change.outdatedIpv4 && !change.updatedIpv4) {
          // this does currently not happen, as we exclude ipv6 only interfaces
          // thus such a change would be happening through the REMOVED array
          assert.fail("Reached illegal state! IPV4 address change from defined to undefined!");
        } else if (change.outdatedIpv4 && change.updatedIpv4) {
          try {
            socket!.dropMembership(MDNSServer.MULTICAST_IPV4, change.outdatedIpv4);
          } catch (error) {
            debug("Thrown expected error when dropping outdated address membership: " + error.message);
          }
          try {
            socket!.addMembership(MDNSServer.MULTICAST_IPV4, change.updatedIpv4);
          } catch (error) {
            debug("Thrown expected error when adding new address membership: " + error.message);
          }

          socket!.setMulticastInterface(change.updatedIpv4);
        }
      }
    }

    if (networkUpdate.added) {
      for (const networkInterface of networkUpdate.added) {
        const socket = this.createDgramSocket(networkInterface.name, true);
        this.bindSocket(socket, networkInterface.name, IPFamily.IPv4).then(() => {
          this.sockets.set(networkInterface.name, socket);
        });
      }
    }
  }

}
