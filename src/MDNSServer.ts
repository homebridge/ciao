import dgram, {Socket} from "dgram";
import dnsPacket, {
  AnswerRecord,
  DecodedDnsPacket,
  EncodingDnsPacket,
  Opcode,
  QuestionRecord,
  RCode,
} from "@homebridge/dns-packet";
import {AddressInfo} from "net";
import {IPFamily} from "./index";
import assert from "assert";
import os from "os";

const MDNS_PORT = 5353;
const MULTICAST_IPV4 = "224.0.0.251";
const MULTICAST_IPV6 = "FF02::FB";

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

// eslint-disable-next-line
export interface ServerOptions {
  // TODO add some options
}

export interface PacketHandler {

  handleQuery(packet: DecodedDnsPacket, rinfo: AddressInfo): void;

  handleResponse(packet: DecodedDnsPacket, rinfo: AddressInfo): void;

}

export class MDNSServer {

  private readonly handler: PacketHandler;

  private readonly udp4Socket: Socket;
  //private readonly udp6Socket: Socket; // TODO add support for udp6 socket (somehow check if dual stack is available?)

  constructor(handler: PacketHandler, options?: ServerOptions) {
    assert(handler, "handler cannot be undefined");
    this.handler = handler;

    this.udp4Socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.udp4Socket.on("message", this.handleMessage.bind(this));
    this.udp4Socket.on("error", this.handleSocketError.bind(this));

    //this.udp6Socket = dgram.createSocket("udp6");
    //this.udp6Socket.on("message", this.handleMessage.bind(this));
  }

  async bind(): Promise<void> {
    // TODO support socket binding to specific address (?)

    return new Promise(resolve => {
      this.udp4Socket.bind(MDNS_PORT, () => {
        this.setupSocket(this.udp4Socket, IPFamily.IPv4);
        resolve();
      });

      // this.udp6Socket.bind(5353, this.setupSocket.bind(this, this.udp6Socket, IPFamily.IPv6));
    });
  }

  private setupSocket(socket: Socket, family: IPFamily): void {
    const mdnsAddress = family === IPFamily.IPv4? MULTICAST_IPV4: MULTICAST_IPV6;
    const interfaces = MDNSServer.getOneAddressForEveryInterface(family);

    if (interfaces.length === 0) {
      socket.addMembership(mdnsAddress);
    } else {
      // TODO loop to add new interfaces and announce new AAAA and A records
      interfaces.forEach(address => socket.addMembership(mdnsAddress, address));
    }

    socket.setMulticastTTL(255);
    socket.setTTL(255);

    socket.setMulticastLoopback(false); // loops back packets to our own host TODO change
  }

  public sendQuery(query: DnsQuery, callback?: () => void): void
  public sendQuery(query: DnsQuery, address?: string, port?: number, callback?: () => void): void;
  public sendQuery(query: DnsQuery, address?: (() => void) | string, port?: number, callback?: () => void): void {
    if (typeof address === "function") {
      callback = address;
      address = undefined;
      port = undefined;
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
    this.send(encoded, address, port, callback);
  }

  public sendResponse(response: DnsResponse, callback?: () => void): void;
  public sendResponse(response: DnsResponse, rinfo?: AddressInfo, callback?: () => void): void;
  public sendResponse(response: DnsResponse, rinfo?: AddressInfo | (() => void), callback?: () => void): void {
    if (typeof rinfo === "function") {
      callback = rinfo;
      rinfo = undefined;
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
    this.send(encoded, rinfo?.address, rinfo?.port, callback);
  }

  private send(message: Buffer, address: string = MULTICAST_IPV4, port: number = MDNS_PORT, callback?: () => void) {
    // TODO check how many answers can fit into one packet

    //const socket = rinfo.family === "IPv4"? this.udp4Socket: this.udp6Socket;
    const socket = this.udp4Socket;
    socket.send(message, port, address, callback); // TODO the callback takes an error in theory
  }

  private handleMessage(buffer: Buffer, rinfo: AddressInfo): void {
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

    if (packet.type === "query") {
      if (packet.flag_tc) {
        // RFC 6763 18.5 flag indicates that additional known-answer records follow shortly
        // TODO wait here for those additional known-answer records READ RFC 6762 7.2
        throw new Error("Truncated messages are currently unsupported");
      }

      this.handler.handleQuery(packet, rinfo);
    } else if (packet.type === "response") {
      if (rinfo.port !== MDNS_PORT) {
        // RFC 6762 6.  Multicast DNS implementations MUST silently ignore any Multicast DNS responses
        //    they receive where the source UDP port is not 5353.
        return;
      }

      // TODO A Multicast DNS querier MUST only accept unicast responses if
      //    they answer a recently sent query (e.g., sent within the last two
      //    seconds) that explicitly requested unicast responses.  A Multicast
      //    DNS querier MUST silently ignore all other unicast responses.

      this.handler.handleResponse(packet, rinfo);
    }
  }

  private handleSocketError(error: Error): void {
    console.warn("Encountered MDNS socket error: " + error.message);
    console.warn(error.stack);
    // TODO do we have any error handlers?
  }

  private static getOneAddressForEveryInterface(family: IPFamily): string[] {
    assert(family, "family must be defined");

    const addresses: string[] = [];

    Object.values(os.networkInterfaces()).forEach(interfaces => {
      for (const interfaceInfo of interfaces) {
        if (interfaceInfo.family === family) {
          addresses.push(interfaceInfo.address);
          break; // addMembership can only be called once per interface
        }
      }
    });

    return addresses;
  }

  public static getAccessibleAddresses(rinfo?: AddressInfo): string[] {
    // TODO ebaauw: "Also notice the IPv6 address from HAP isn't correct: %<0> instead of %en1?!"

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
