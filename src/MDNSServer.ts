import dnsPacket, {
  AnswerRecord,
  DecodedDnsPacket,
  EncodingDnsPacket,
  Opcode,
  QuestionRecord,
  RCode,
} from "@homebridge/dns-packet";
import assert from "assert";
import dgram, { Socket } from "dgram";
import { AddressInfo } from "net";
import { IPFamily } from "./index";
import { NetworkChange, NetworkManager, NetworkManagerEvent } from "./NetworkManager";

export interface DnsResponse {
  flags?: number;
  id?: number;
  questions?: QuestionRecord[];
  answers: AnswerRecord[];
  authorities?: AnswerRecord[];
  additionals?: AnswerRecord[];
}

export interface DnsQuery {
  flags?: number;
  id?: number;
  questions: QuestionRecord[];
  answers?: AnswerRecord[];
  authorities?: AnswerRecord[];
  additionals?: AnswerRecord[];
}

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

  handleQuery(packet: DecodedDnsPacket, rinfo: EndpointInfo): void;

  handleResponse(packet: DecodedDnsPacket, rinfo: EndpointInfo): void;

}

/**
 * This class can be used to create a mdns server to send and receive mdns packets on the local network.
 *
 * There are some limitations, please refer to https://github.com/homebridge/ciao/wiki/Unicast-Response-Workaround.
 *
 * Currently only udp4 sockets will be advertised.
 */
export class MDNSServer {

  public static readonly MDNS_PORT = 5353;
  public static readonly MDNS_TTL = 255;
  public static readonly MULTICAST_IPV4 = "224.0.0.251";
  public static readonly MULTICAST_IPV6 = "FF02::FB";

  private readonly handler: PacketHandler;

  private readonly networkManager: NetworkManager;

  // map indexed by interface name, udp4 sockets
  private readonly multicastSockets: Map<string, Socket> = new Map();
  private readonly unicastSockets: Map<string, Socket> = new Map();

  private bound = false;
  private closed = false;

  constructor(handler: PacketHandler, options?: MDNSServerOptions) {
    assert(handler, "handler cannot be undefined");
    this.handler = handler;

    this.networkManager = new NetworkManager({
      interface: options && options.interface,
      excludeIpv6Only: true,
    });
    this.networkManager.on(NetworkManagerEvent.INTERFACE_UPDATE, this.handleUpdatedNetworkInterfaces.bind(this));

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

  public getInterfaces(): IterableIterator<string> {
    return this.multicastSockets.keys();
  }

  public getInterfaceCount(): number {
    return this.multicastSockets.size;
  }

  public async bind(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot rebind closed server!");
    }

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

    // TODO sockets can already be closed when the interface was shut down previously :thinking:
    for (const socket of this.multicastSockets.values()) {
      socket.close();
    }

    for (const socket of this.unicastSockets.values()) {
      socket.close();
    }

    this.bound = false;
    this.closed = true;

    this.multicastSockets.clear();
    this.unicastSockets.clear();
  }

  public sendQueryBroadcast(query: DnsQuery, callback?: SendCallback): void {
    const packet: EncodingDnsPacket = {
      type: "query",
      flags: query.flags || 0,
      id: query.id,
      questions: query.questions,
      answers: query.answers,
      authorities: query.authorities,
      additionals: query.additionals,
    };

    this.sendOnAllInterfaces(packet, callback);
  }

  public sendResponse(response: DnsResponse, endpoint: EndpointInfo, callback?: SendCallback): void;
  public sendResponse(response: DnsResponse, outInterface: string, callback?: SendCallback): void;
  public sendResponse(response: DnsResponse, endpointOrInterface: EndpointInfo | string, callback?: SendCallback): void {
    const packet: EncodingDnsPacket = {
      type: "response",
      flags: response.flags || 0,
      id: response.id,
      questions: response.questions,
      answers: response.answers,
      authorities: response.authorities,
      additionals: response.additionals,
    };

    packet.flags! |= dnsPacket.AUTHORITATIVE_ANSWER; // RFC 6763 18.4 AA MUST be set

    this.send(packet, endpointOrInterface, callback);
  }

  public sendResponseBroadcast(response: DnsResponse, callback?: SendCallback): void {
    const packet: EncodingDnsPacket = {
      type: "response",
      flags: response.flags || 0,
      id: response.id,
      questions: response.questions,
      answers: response.answers,
      authorities: response.authorities,
      additionals: response.additionals,
    };

    packet.flags! |= dnsPacket.AUTHORITATIVE_ANSWER; // RFC 6763 18.4 AA MUST be set

    this.sendOnAllInterfaces(packet, callback);
  }

  private sendOnAllInterfaces(packet: EncodingDnsPacket, callback?: SendCallback): void {
    const message = dnsPacket.encode(packet);
    this.assertBeforeSend(message);

    const socketMap = packet.type === "response"? this.multicastSockets: this.unicastSockets;

    let socketCount = socketMap.size;
    const encounteredErrors: Error[] = [];

    /*
     * We are sending the packet from every socket we have bound, meaning on every interface.
     * Typically a device is connected to multiple interfaces if it participates in multiple networks.
     * There is also the case where we are connected to the same network more than one time, for example
     * over Ethernet and Wifi. In that case we will send packets twice, but we can't really detect that scenario.
     */
    for (const [name, socket] of socketMap) {
      socket.send(message, MDNSServer.MDNS_PORT, MDNSServer.MULTICAST_IPV4, error => {
        if (!callback) {
          if (error) {
            MDNSServer.handleSocketError(name, error);
          }
          return;
        }

        if (error) {
          encounteredErrors.push(error);
        }

        if (--socketCount <= 0) {
          if (encounteredErrors.length > 0) {
            callback(new Error("Socket errors: " + encounteredErrors.map(error => error.stack).join(";")));
          } else {
            callback();
          }
        }
      });
    }
  }

  private send(packet: EncodingDnsPacket, endpointOrInterface: EndpointInfo | string, callback?: SendCallback): void {
    const message = dnsPacket.encode(packet);
    this.assertBeforeSend(message);

    let address;
    let port;
    let networkInterface;

    if (typeof endpointOrInterface === "string") { // it a interface name
      address = MDNSServer.MULTICAST_IPV4;
      port = MDNSServer.MDNS_PORT;
      networkInterface = endpointOrInterface;
    } else {
      address = endpointOrInterface.address;
      port = endpointOrInterface.port;
      networkInterface = endpointOrInterface.interface;
    }

    const socketMap = packet.type === "response"? this.multicastSockets: this.unicastSockets;
    const socket = socketMap.get(networkInterface);
    assert(socket, `Could not find socket for given interface '${networkInterface}'`);

    socket!.send(message, port, address, callback);
  }

  private assertBeforeSend(message: Buffer): void {
    assert(this.bound, "Cannot send packets before server is not bound!");
    assert(!this.closed, "Cannot send packets on a closed mdns server!");
    assert(message.length <= 1024, "MDNS packet size cannot be larger than 1024 bytes");
  }

  private createDgramSocket(interfaceName: string, reuseAddr = false, type: "udp4" | "udp6" = "udp4"): Socket {
    const socket = dgram.createSocket({
      type: type,
      reuseAddr: reuseAddr,
    });

    socket.on("message", this.handleMessage.bind(this, interfaceName));
    socket.on("error", MDNSServer.handleSocketError.bind(this, interfaceName));

    return socket;
  }

  private bindMulticastSocket(socket: Socket, interfaceName: string, family: IPFamily): Promise<void> {
    const networkInterface = this.networkManager.getInterface(interfaceName);
    assert(networkInterface, "Could not find network interface '" + interfaceName + "' in network manager which socket was bound to!");

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      socket.bind(MDNSServer.MDNS_PORT, () => {
        socket.removeListener("error", errorHandler);

        const multicastAddress = family === IPFamily.IPv4? MDNSServer.MULTICAST_IPV4: MDNSServer.MULTICAST_IPV6;
        const interfaceAddress = family === IPFamily.IPv4? networkInterface!.ipv4: networkInterface!.ipv6;

        socket.addMembership(multicastAddress, interfaceAddress);

        socket.setMulticastTTL(MDNSServer.MDNS_TTL); // outgoing multicast datagrams
        socket.setTTL(MDNSServer.MDNS_TTL); // outgoing unicast datagrams

        socket.setMulticastLoopback(true);

        resolve();
      });
    });
  }

  private bindUnicastSocket(socket: Socket, interfaceName: string): Promise<void> {
    const networkInterface = this.networkManager.getInterface(interfaceName);
    assert(networkInterface, "Could not find network interface '" + interfaceName + "' in network manager which socket was bound to!");

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      // bind on random port
      socket.bind(() => {
        socket.removeListener("error", errorHandler);

        socket.setMulticastTTL(255); // outgoing multicast datagrams
        socket.setTTL(255); // outgoing unicast datagrams

        resolve();
      });
    });
  }

  private handleMessage(interfaceName: string, buffer: Buffer, rinfo: AddressInfo): void {
    if (!this.bound) {
      return;
    }

    let packet: DecodedDnsPacket;
    try {
      packet = dnsPacket.decode(buffer);
    } catch (error) {
      console.warn("Received malformed packet from " + rinfo + ": " + error.message);
      return;
    }

    if (packet.opcode !== Opcode.QUERY) {
      // RFC 6762 18.3 we MUST ignore messages with opcodes other than zero (QUERY)
      return;
    }

    if (packet.rcode !== RCode.NOERROR) {
      // RFC 6762 18.3 we MUST ignore messages with response code other than zero (NOERROR)
      return;
    }

    const endpoint: EndpointInfo = {
      address: rinfo.address,
      port: rinfo.port,
      interface: interfaceName,
    };

    if (packet.type === "query") {
      this.handler.handleQuery(packet, endpoint);
    } else if (packet.type === "response") {
      if (rinfo.port !== MDNSServer.MDNS_PORT) {
        // RFC 6762 6.  Multicast DNS implementations MUST silently ignore any Multicast DNS responses
        //    they receive where the source UDP port is not 5353.
        return;
      }

      this.handler.handleResponse(packet, endpoint);
    }
  }

  private static handleSocketError(interfaceName: string, error: Error): void {
    console.warn("Encountered MDNS socket error on socket " + interfaceName + " : " + error.message);
    console.warn(error.stack);
  }

  private handleUpdatedNetworkInterfaces(change: NetworkChange): void {
    if (change.removed) {
      change.removed.forEach(networkInterface => {
        const multicastSocket = this.multicastSockets.get(networkInterface.name);
        this.multicastSockets.delete(networkInterface.name);
        const unicastSocket = this.unicastSockets.get(networkInterface.name);
        this.multicastSockets.delete(networkInterface.name);

        // TODO "close" can throw if the network interface already closed before exiting
        if (multicastSocket) {
          multicastSocket.close();
        }
        if (unicastSocket) {
          unicastSocket.close();
        }
      });
    }

    // TODO check the updated addresses (an interface change may only remove the ipv4 address but still maintain the ipv6, thus the interface is not removed completely)
    //  or the address simply changed to another address

    if (change.added) {
      change.added.forEach(networkInterface => {
        const name = networkInterface.name;

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
      });
    }
  }

}
