import assert from "assert";
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
import { IPFamily } from "./index";
import { InterfaceName, NetworkManager, NetworkManagerEvent, NetworkUpdate } from "./NetworkManager";

export interface EndpointInfo {
  address: string;
  port: number;
  interface: string;
}

export type SendCallback = (error?: Error | null) => void;

// eslint-disable-next-line
export interface MDNSServerOptions {
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
 * There are some limitations, please refer to https://github.com/homebridge/ciao/wiki/Unicast-Response-Workaround.
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

  private readonly multicastSockets: Map<InterfaceName, Socket> = new Map();
  private readonly unicastSockets: Map<InterfaceName, Socket> = new Map();
  // TODO remove unicastSockets, detect if we are not alone on the machine and if so force NOT setting the QU flag
  // TODO if we remove this, we must make sure that we don't respond to our own queries when reannouncing the
  //  service (for example when a new network interface got added)

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

    for (const name of this.networkManager.getInterfaceMap().keys()) {
      const multicast = this.createDgramSocket(name, true);
      const unicast = this.createDgramSocket(name);

      this.multicastSockets.set(name, multicast);
      this.unicastSockets.set(name, unicast);
    }

    if (this.multicastSockets.size === 0) { // misconfigured options
      throw new Error("Did not bind any sockets!");
    }
  }

  public getNetworkManager(): NetworkManager {
    return this.networkManager;
  }

  public getNetworkCount(): number {
    return this.multicastSockets.size;
  }

  public async bind(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot rebind closed server!");
    }

    // TODO RFC 6762 15.1: In most operating systems, incoming *multicast* packets can be
    //    delivered to *all* open sockets bound to the right port number,
    //    provided that the clients take the appropriate steps to allow this.
    //    For this reason, all Multicast DNS implementations SHOULD use the
    //    SO_REUSEPORT and/or SO_REUSEADDR options (or equivalent as
    //    appropriate for the operating system in question) so they will all be
    //    able to bind to UDP port 5353 and receive incoming multicast packets
    //    addressed to that port.  However, unlike multicast packets, incoming
    //    unicast UDP packets are typically delivered only to the first socket
    //    to bind to that port.  This means that "QU" responses and other
    //    packets sent via unicast will be received only by the first Multicast
    //    DNS responder and/or querier on a system.  This limitation can be
    //    partially mitigated if Multicast DNS implementations detect when they
    //    are not the first to bind to port 5353, and in that case they do not
    //    request "QU" responses.  One way to detect if there is another
    //    Multicast DNS implementation already running is to attempt binding to
    //    port 5353 without using SO_REUSEPORT and/or SO_REUSEADDR, and if that
    //    fails it indicates that some other socket is already bound to this
    //    port.

    const promises: Promise<void>[] = [];

    for (const [name, socket] of this.multicastSockets) {
      promises.push(this.bindMulticastSocket(socket, name, IPFamily.IPv4));
    }

    for (const [name, socket] of this.unicastSockets) {
      promises.push(this.bindUnicastSocket(socket, name));
    }

    return Promise.all(promises).then(() => {
      this.bound = true;
      // map void[] to void
    });
  }

  public shutdown(): void {
    this.networkManager.shutdown();

    for (const socket of this.multicastSockets.values()) {
      socket.close();
    }

    // TODO sockets can already be closed when the interface was shut down previously :thinking:
    for (const socket of this.unicastSockets.values()) {
      socket.close();
    }

    this.bound = false;
    this.closed = true;

    this.multicastSockets.clear();
    this.unicastSockets.clear();
  }

  public sendQueryBroadcast(query: DNSQueryDefinition | DNSProbeQueryDefinition, callback?: SendCallback): void {
    const packets = DNSPacket.createDNSQueryPackets(query, MDNSServer.MTU, IPFamily.IPv4);

    const promises: Promise<void>[] = [];
    for (const packet of packets) {
      promises.push(this.sendOnAllNetworks(packet, PacketType.QUERY));
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

    const promises: Promise<void>[] = [];
    for (const packet of packets) {
      promises.push(this.sendOnAllNetworks(packet, PacketType.RESPONSE));
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

  private sendOnAllNetworks(packet: DNSPacket, type: PacketType): Promise<void> {
    const message = packet.encode();
    this.assertBeforeSend(message, IPFamily.IPv4);

    const socketMap =  type === PacketType.RESPONSE? this.multicastSockets: this.unicastSockets;

    const promises: Promise<void>[] = [];
    for (const [name, socket] of socketMap) {
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

    const socketMap = packet.type === PacketType.RESPONSE? this.multicastSockets: this.unicastSockets;
    const socket = socketMap.get(name);
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

  private bindMulticastSocket(socket: Socket, name: InterfaceName, family: IPFamily): Promise<void> {
    const networkInterface = this.networkManager.getInterface(name);
    assert(networkInterface, "Could not find network interface '" + name + "' in network manager which socket is going to be bind to!");

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      socket.bind(MDNSServer.MDNS_PORT, () => {
        socket.removeListener("error", errorHandler);

        const multicastAddress = family === IPFamily.IPv4? MDNSServer.MULTICAST_IPV4: MDNSServer.MULTICAST_IPV6;
        const interfaceAddress = family === IPFamily.IPv4? networkInterface!.ipv4: networkInterface!.ipv6;
        assert(interfaceAddress, "Interface address canot be undefined!");

        socket.addMembership(multicastAddress, interfaceAddress!);

        socket.setMulticastInterface(interfaceAddress!);

        socket.setMulticastTTL(MDNSServer.MDNS_TTL); // outgoing multicast datagrams
        socket.setTTL(MDNSServer.MDNS_TTL); // outgoing unicast datagrams

        socket.setMulticastLoopback(true);

        resolve();
      });
    });
  }

  private bindUnicastSocket(socket: Socket, name: InterfaceName): Promise<void> {
    const networkInterface = this.networkManager.getInterface(name);
    assert(networkInterface, "Could not find network interface '" + name + "' in network manager which socket is going to be bind to!");

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      // bind on random port
      socket.bind(0, networkInterface!.ipv4, () => {
        socket.removeListener("error", errorHandler);

        socket.setMulticastTTL(MDNSServer.MDNS_TTL); // outgoing multicast datagrams
        socket.setTTL(MDNSServer.MDNS_TTL); // outgoing unicast datagrams

        resolve();
      });
    });
  }

  private handleMessage(name: InterfaceName, buffer: Buffer, rinfo: AddressInfo): void {
    if (!this.bound) {
      return;
    }

    let packet: DNSPacket;
    try {
      packet = DNSPacket.decode(buffer);
    } catch (error) {
      // TODO move this to debug level once we have a fairly stable library
      console.warn("Received malformed packet from " + JSON.stringify(rinfo) + ": " + error.message);
      console.warn(error.stack); // TODO remove
      return;
    }

    if (packet.opcode !== OpCode.QUERY) {
      // RFC 6762 18.3 we MUST ignore messages with opcodes other than zero (QUERY)
      return;
    }

    if (packet.rcode !== RCode.NoError) {
      // RFC 6762 18.3 we MUST ignore messages with response code other than zero (NOERROR)
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
        this.removeSockets(networkInterface.name);
      }
    }

    if (networkUpdate.changes) {
      // TODO rebind our unicast socket if we detect ipv4 changes (added/remove/updated)
    }

    if (networkUpdate.added) {
      for (const networkInterface of networkUpdate.added) {
        this.addAndBindSocket(networkInterface.name);
      }
    }
  }

  private addAndBindSocket(name: InterfaceName): void {
    const multicast = this.createDgramSocket(name, true);
    const unicast = this.createDgramSocket(name);

    const promises = [
      this.bindMulticastSocket(multicast, name, IPFamily.IPv4),
      this.bindUnicastSocket(unicast, name),
    ];

    Promise.all(promises).then(() => {
      this.multicastSockets.set(name, multicast);
      this.unicastSockets.set(name, unicast);
    });
  }

  private removeSockets(name: InterfaceName): void {
    const multicastSocket = this.multicastSockets.get(name);
    this.multicastSockets.delete(name);
    const unicastSocket = this.unicastSockets.get(name);
    this.multicastSockets.delete(name);

    if (multicastSocket) {
      try {
        multicastSocket.close();
      } catch (error) {
        console.log(error.stack); // TODO remove or properly handle
      }
    }
    if (unicastSocket) {
      try {
        unicastSocket.close();
      } catch (error) {
        console.log(error.stack); // TODO remove or properly handle
      }
    }
  }

}
