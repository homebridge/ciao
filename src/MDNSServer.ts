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
import { NetworkUpdate, NetworkManager, NetworkManagerEvent, NetworkId } from "./NetworkManager";
import createDebug from "debug";

const debug = createDebug("ciao:MDNSServer");

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
  network: string;
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

  /*
  TODO random RFC note
  From section 6.2 of RFC 1035 <https://tools.ietf.org/html/rfc1035>:
    //    When a response is so long that truncation is required, the truncation
    //    should start at the end of the response and work forward in the
    //    datagram.  Thus if there is any data for the authority section, the
    //    answer section is guaranteed to be unique.
   */

  public static readonly MDNS_PORT = 5353;
  public static readonly MDNS_TTL = 255;
  public static readonly MULTICAST_IPV4 = "224.0.0.251";
  public static readonly MULTICAST_IPV6 = "FF02::FB";

  private readonly handler: PacketHandler;

  private readonly networkManager: NetworkManager;

  private readonly multicastSockets: Map<NetworkId, Socket> = new Map();
  private readonly unicastSockets: Map<NetworkId, Socket> = new Map();

  private bound = false;
  private closed = false;

  constructor(handler: PacketHandler, options?: MDNSServerOptions) {
    assert(handler, "handler cannot be undefined");
    this.handler = handler;

    this.networkManager = new NetworkManager({
      interface: options && options.interface,
      excludeIpv6Only: true,
    });
    this.networkManager.on(NetworkManagerEvent.NETWORK_UPDATE, this.handleNetworkUpdate.bind(this));

    for (const name of this.networkManager.getNetworkMap().keys()) {
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

  public getNetworkIds(): IterableIterator<NetworkId> {
    return this.multicastSockets.keys();
  }

  public getNetworkCount(): number {
    return this.multicastSockets.size;
  }

  public async bind(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot rebind closed server!");
    }

    const promises: Promise<void>[] = [];

    for (const [id, socket] of this.multicastSockets) {
      promises.push(this.bindMulticastSocket(socket, id, IPFamily.IPv4));
    }

    for (const [id, socket] of this.unicastSockets) {
      promises.push(this.bindUnicastSocket(socket, id));
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

    this.sendOnAllNetworks(packet, callback);
  }

  public sendResponse(response: DnsResponse, endpoint: EndpointInfo, callback?: SendCallback): void;
  public sendResponse(response: DnsResponse, networkId: NetworkId, callback?: SendCallback): void;
  public sendResponse(response: DnsResponse, endpointOrNetwork: EndpointInfo | NetworkId, callback?: SendCallback): void {
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

    this.send(packet, endpointOrNetwork, callback);
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

    this.sendOnAllNetworks(packet, callback);
  }

  private sendOnAllNetworks(packet: EncodingDnsPacket, callback?: SendCallback): void {
    const message = dnsPacket.encode(packet);
    this.assertBeforeSend(packet, message);

    const socketMap = packet.type === "response"? this.multicastSockets: this.unicastSockets;

    let socketCount = socketMap.size;
    const encounteredErrors: Error[] = [];

    for (const [id, socket] of socketMap) {
      socket.send(message, MDNSServer.MDNS_PORT, MDNSServer.MULTICAST_IPV4, error => {
        if (!callback) {
          if (error) {
            MDNSServer.handleSocketError(id, error);
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

  private send(packet: EncodingDnsPacket, endpointOrNetwork: EndpointInfo | NetworkId, callback?: SendCallback): void {
    const message = dnsPacket.encode(packet);
    this.assertBeforeSend(packet, message);

    let address;
    let port;
    let network;

    if (typeof endpointOrNetwork === "string") { // its a network id
      address = MDNSServer.MULTICAST_IPV4;
      port = MDNSServer.MDNS_PORT;
      network = endpointOrNetwork;
    } else {
      address = endpointOrNetwork.address;
      port = endpointOrNetwork.port;
      network = endpointOrNetwork.network;
    }

    const socketMap = packet.type === "response"? this.multicastSockets: this.unicastSockets;
    const socket = socketMap.get(network);
    assert(socket, `Could not find socket for given network '${network}'`);

    socket!.send(message, port, address, callback);
  }

  private assertBeforeSend(packet: EncodingDnsPacket, message: Buffer): void {
    assert(this.bound, "Cannot send packets before server is not bound!");
    assert(!this.closed, "Cannot send packets on a closed mdns server!");
    if (message.length > 1024) { // TODO still need to check what we need to do?
      debug("packet with exceeds the record size of 1024 with " + message.length);
    }
    //assert(message.length <= 1024, "MDNS packet size cannot be larger than 1024 bytes for " + message.length + " " + JSON.stringify(packet)); // TODO we might want to tackle this
  }

  private createDgramSocket(id: NetworkId, reuseAddr = false, type: "udp4" | "udp6" = "udp4"): Socket {
    const socket = dgram.createSocket({
      type: type,
      reuseAddr: reuseAddr,
    });

    socket.on("message", this.handleMessage.bind(this, id));
    socket.on("error", MDNSServer.handleSocketError.bind(this, id));

    return socket;
  }

  private bindMulticastSocket(socket: Socket, id: NetworkId, family: IPFamily): Promise<void> {
    const network = this.networkManager.getNetworkById(id);
    assert(network, "Could not find network '" + id + "' in network manager which socket is going to be bind to!");

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      socket.bind(MDNSServer.MDNS_PORT, () => {
        socket.removeListener("error", errorHandler);

        const multicastAddress = family === IPFamily.IPv4? MDNSServer.MULTICAST_IPV4: MDNSServer.MULTICAST_IPV6;
        const addresses = family === IPFamily.IPv4? network!.getIPv4Addresses(): network!.getIPv6Addresses();

        for (const interfaceAddress of addresses) {
          socket.addMembership(multicastAddress, interfaceAddress);
        }

        socket.setMulticastTTL(MDNSServer.MDNS_TTL); // outgoing multicast datagrams
        socket.setTTL(MDNSServer.MDNS_TTL); // outgoing unicast datagrams

        socket.setMulticastLoopback(true);

        resolve();
      });
    });
  }

  private bindUnicastSocket(socket: Socket, id: NetworkId): Promise<void> {
    const network = this.networkManager.getNetworkById(id);
    assert(network, "Could not find network '" + id + "' in network manager which socket is going to be bind to!");

    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error | number): void => reject(error);
      socket.once("error", errorHandler);

      // bind on random port
      socket.bind(0, network!.getDefaultIPv4(), () => {
        socket.removeListener("error", errorHandler);

        socket.setMulticastTTL(255); // outgoing multicast datagrams
        socket.setTTL(255); // outgoing unicast datagrams

        resolve();
      });
    });
  }

  private handleMessage(id: NetworkId, buffer: Buffer, rinfo: AddressInfo): void {
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
      network: id,
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

  private static handleSocketError(id: NetworkId, error: Error): void {
    console.warn("Encountered MDNS socket error on socket " + id + " : " + error.message);
    console.warn(error.stack);
  }

  private handleNetworkUpdate(update: NetworkUpdate): void {
    if (update.removed) {
      for (const network of update.removed) {
        this.removeSocket(network.getId());
      }
    }

    if (update.updated) {
      for (const change of update.updated) {
        if (!change.changedDefaultIPv4Address) {
          continue;
        }

        // the default address changed were the socket was running
        this.removeSocket(change.networkId);
        this.addAndBindSocket(change.networkId);
      }
    }

    if (update.added) {
      for (const network of update.added) {
        this.addAndBindSocket(network.getId());
      }
    }
  }

  private addAndBindSocket(id: NetworkId): void {
    const multicast = this.createDgramSocket(id, true);
    const unicast = this.createDgramSocket(id);

    const promises = [
      this.bindMulticastSocket(multicast, id, IPFamily.IPv4),
      this.bindUnicastSocket(unicast, id),
    ];

    Promise.all(promises).then(() => {
      this.multicastSockets.set(id, multicast);
      this.unicastSockets.set(id, unicast);
    });
  }

  private removeSocket(id: NetworkId): void {
    const multicastSocket = this.multicastSockets.get(id);
    this.multicastSockets.delete(id);
    const unicastSocket = this.unicastSockets.get(id);
    this.multicastSockets.delete(id);

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
