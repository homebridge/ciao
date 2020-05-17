import dgram, { Socket } from "dgram";
import dnsPacket, {
  AnswerRecord,
  DecodedDnsPacket,
  EncodingDnsPacket,
  Opcode,
  QuestionRecord,
  RCode,
} from "@homebridge/dns-packet";
import { AddressInfo } from "net";
import { IPFamily } from "./index";
import assert from "assert";
import os from "os";
import { NetworkChange, NetworkManager } from "./NetworkManager";

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

export type SendCallback = (error: Error | null) => void;

// eslint-disable-next-line
export interface ServerOptions {
  // TODO add some options
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

  // TODO maybe add support for udp6 sockets?

  // map indexed by interface name, udp4 sockets
  private readonly multicastSockets: Map<string, Socket> = new Map();
  private readonly unicastSockets: Map<string, Socket> = new Map();

  private bound = false;

  constructor(handler: PacketHandler, options?: ServerOptions) {
    assert(handler, "handler cannot be undefined");
    this.handler = handler;

    this.networkManager = new NetworkManager();
    // TODO set up update listener
    // TODO when removed socket may not yet be bound

    for (const [name, networkInterface] of this.networkManager.getInterfaceMap()) {
      if (!networkInterface.ipv4) { // TODO ipv6 support
        continue;
      }

      // TODO we should additionally bind a port on the loopback address

      const multicast = this.createDgramSocket(name, true);
      const unicast = this.createDgramSocket(name);

      this.multicastSockets.set(name, multicast);
      this.unicastSockets.set(name, unicast);
    }
  }

  public async bind(): Promise<void> {
    const promises: Promise<void>[] = [this.networkManager.waitForDefaultNetworkInterface()];

    for (const [name, socket] of this.multicastSockets) {
      promises.push(this.bindMulticastSocket(socket, name, IPFamily.IPv4));
    }

    for (const [name, socket] of this.unicastSockets) {
      promises.push(this.bindUnicastSocket(socket, name));
    }

    console.log("Waiting for server to bind");

    return Promise.all(promises).then(() => {
      this.bound = true;
      // map void[] to void
    });
  }

  public sendQuery(query: DnsQuery, callback?: SendCallback): void
  public sendQuery(query: DnsQuery, endpoint?: EndpointInfo, callback?: SendCallback): void;
  public sendQuery(query: DnsQuery, endpoint?: EndpointInfo | SendCallback, callback?: SendCallback): void {
    if (typeof endpoint === "function") {
      callback = endpoint;
      endpoint = undefined;
    }

    const packet: EncodingDnsPacket = {
      type: "query",
      flags: query.flags || 0,
      id: query.id,
      questions: query.questions,
      answers: query.answers,
      authorities: query.authorities,
      additionals: query.additionals,
    };

    const encoded = dnsPacket.encode(packet);
    this.send(encoded, this.unicastSockets, endpoint, callback);
  }

  public sendResponse(response: DnsResponse, callback?: SendCallback): void;
  public sendResponse(response: DnsResponse, endpoint?: EndpointInfo, callback?: SendCallback): void;
  public sendResponse(response: DnsResponse, endpoint?: EndpointInfo | SendCallback, callback?: SendCallback): void {
    if (typeof endpoint === "function") {
      callback = endpoint;
      endpoint = undefined;
    }

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

    const encoded = dnsPacket.encode(packet);
    this.send(encoded, this.multicastSockets, endpoint, callback);
  }

  private send(message: Buffer, socketMap: Map<string, Socket>, endpoint?: Partial<EndpointInfo>, callback?: SendCallback): void {
    assert(this.bound, "Cannot send packets before server is not bound!");

    const address = endpoint?.address || MDNSServer.MULTICAST_IPV4; // TODO support for ipv6
    const port = endpoint?.port || MDNSServer.MDNS_PORT;
    const outInterface = endpoint?.interface || this.networkManager.getDefaultNetworkInterface();

    const socket = socketMap.get(outInterface);
    assert(socket, "Could not find socket for given interface '" + outInterface + "'");

    // TODO check how many answers can fit into one packet

    socket!.send(message, port, address, callback);
    // TODO if no callback is supplied error event is raised (should we raise the event anyways and not rely on users to handle errors correctly?)
  }

  private createDgramSocket(interfaceName: string, reuseAddr = false, type: "udp4" | "udp6" = "udp4"): Socket {
    const socket = dgram.createSocket({
      type: type,
      reuseAddr: reuseAddr,
    });

    socket.on("message", this.handleMessage.bind(this, interfaceName));
    socket.on("error", this.handleSocketError.bind(this, interfaceName));

    return socket;
  }

  private bindMulticastSocket(socket: Socket, interfaceName: string, family: IPFamily): Promise<void> {
    const networkInterface = this.networkManager.getInterface(interfaceName);
    // TODO should we maybe handle that case where the interface already disappeared before the server is bound?
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
    // TODO should we maybe handle that case where the interface already disappeared before the server is bound?
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
      if (packet.flag_tc) {
        // RFC 6763 18.5 flag indicates that additional known-answer records follow shortly
        // TODO wait here for those additional known-answer records READ RFC 6762 7.2
        throw new Error("Truncated messages are currently unsupported");
      }

      this.handler.handleQuery(packet, endpoint);
    } else if (packet.type === "response") {
      if (rinfo.port !== MDNSServer.MDNS_PORT) {
        // RFC 6762 6.  Multicast DNS implementations MUST silently ignore any Multicast DNS responses
        //    they receive where the source UDP port is not 5353.
        return;
      }

      // TODO A Multicast DNS querier MUST only accept unicast responses if
      //    they answer a recently sent query (e.g., sent within the last two
      //    seconds) that explicitly requested unicast responses.  A Multicast
      //    DNS querier MUST silently ignore all other unicast responses.

      this.handler.handleResponse(packet, endpoint);
    }
  }

  private handleSocketError(interfaceName: string, error: Error): void {
    console.warn("Encountered MDNS socket error on socket " + interfaceName + " : " + error.message);
    console.warn(error.stack);
    // TODO do we have any error handlers?
  }

  private handleUpdatedNetworkInterfaces(change: NetworkChange) {
    if (change.removed) {
      change.removed.forEach(networkInteface => {
        const multicastSocket = this.multicastSockets.get(networkInteface.name);
        this.multicastSockets.delete(networkInteface.name);
        const unicastSocket = this.unicastSockets.get(networkInteface.name);
        this.multicastSockets.delete(networkInteface.name);

        if (multicastSocket) {
          multicastSocket.close();
        }
        if (unicastSocket) {
          unicastSocket.close();
        }
      });
    }

    if (change.added) {
      change.added.forEach(networkInterface => {
        if (!networkInterface.ipv4) { // TODO ipv6 support
          return;
        }

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

  public static getAccessibleAddresses(endpoint?: EndpointInfo): string[] {
    const addresses: string[] = [];

    // TODO only include addresses in the same subnet like the requestor(?)

    // in theory we should only return addresses which are on the same interface
    // as the request came in. But we have no way of getting that information with node
    Object.values(os.networkInterfaces()).forEach(interfaces => {
      interfaces.forEach(interfaceInfo => {
        // RFC 6762 6.2. reads like we include everything also, ipv6 link-local addresses
        if (interfaceInfo.internal || addresses.includes(interfaceInfo.address)) {
          // TODO we may also include loopback addresses if the originator is localhost
          return;
        }

        /* TODO investigate this futher on how to properly expose our available interfaces
        if (rinfo && ip.subnet(interfaceInfo.address, interfaceInfo.netmask).contains(rinfo.address)) {
          return;
        }
         */

        addresses.push(interfaceInfo.address);
      });
    });

    return addresses;
  }

}
