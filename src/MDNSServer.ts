import assert from "assert";
import createDebug from "debug";
import dgram, { Socket } from "dgram";
import { AddressInfo } from "net";
import { CiaoService } from "./CiaoService";
import {
  DNSPacket,
  DNSProbeQueryDefinition,
  DNSQueryDefinition,
  DNSResponseDefinition,
  OpCode,
  PacketType,
  RCode,
} from "./coder/DNSPacket";
import {
  InterfaceName,
  IPFamily,
  NetworkInterface,
  NetworkManager,
  NetworkManagerEvent,
  NetworkUpdate,
} from "./NetworkManager";
import { getNetAddress } from "./util/domain-formatter";
import { InterfaceNotFoundError, ServerClosedError } from "./util/errors";
import { PromiseTimeout } from "./util/promise-utils";

const debug = createDebug("ciao:MDNSServer");

export interface EndpointInfo {
  address: string;
  port: number;
  interface: string;
}

export interface SendFulfilledResult {
  status: "fulfilled",
  interface: InterfaceName,
}

export interface SendRejectedResult {
  status: "rejected",
  interface: InterfaceName,
  reason: Error,
}

export interface SendTimeoutResult {
  status: "timeout",
  interface: InterfaceName,
}

export type SendResult = SendFulfilledResult | SendRejectedResult;
export type TimedSendResult = SendFulfilledResult | SendRejectedResult | SendTimeoutResult;

export type SendCallback = (error?: Error | null) => void;

/**
 * Returns the ration of rejected SendResults in the array.
 * A ratio of 0 indicates all sends were successful.
 * A ration of 1 indicates all sends failed.
 * A number in between signals that some of the sends failed.
 *
 * @param results - Array of {@link SendResult}
 */
export function SendResultFailedRatio(results: SendResult[] | TimedSendResult[]): number {
  if (results.length === 0) {
    return 0;
  }

  let failedCount = 0;

  for (const result of results) {
    if (result.status !== "fulfilled") {
      failedCount++;
    }
  }

  return failedCount / results.length;
}

export function SendResultFormatError(results: SendResult[] | TimedSendResult[], prefix?: string, includeStack = false): string {
  let failedCount = 0;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      failedCount++;
    }
  }

  if (!prefix) {
    prefix = "Failed to send packets";
  }

  if (failedCount < results.length) {
    prefix += ` (${failedCount}/${results.length}):`;
  } else {
    prefix += ":";
  }

  if (includeStack) {
    let string = "=============================\n" + prefix;

    for (const result of results) {
      if (result.status === "rejected") {
        string += "\n--------------------\n" +
          "Failed to send packet on interface " + result.interface + ": " + result.reason.stack;
      } else if (result.status === "timeout") {
        string += "\n--------------------\n" +
          "Sending packet on interface " + result.interface + " timed out!";
      }
    }

    string += "\n=============================";

    return string;
  } else {
    let string = prefix;

    for (const result of results) {
      if (result.status === "rejected") {
        string += "\n- Failed to send packet on interface " + result.interface + ": " + result.reason.message;
      } else if (result.status === "timeout") {
        string += "\n- Sending packet on interface " + result.interface + " timed out!";
      }
    }

    return string;
  }
}

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
  /**
   * If specified, the mdns server will not include any ipv6 address records
   * and not bind any udp6 sockets.
   * This is handy if you want to "bind" on 0.0.0.0 only.
   */
  disableIpv6?: boolean;
}

export interface PacketHandler {

  handleQuery(packet: DNSPacket, rinfo: EndpointInfo): void;

  handleResponse(packet: DNSPacket, rinfo: EndpointInfo): void;

}

/**
 * This class can be used to create a mdns server to send and receive mdns packets on the local network.
 *
 * Currently only udp4 sockets will be advertised.
 */
export class MDNSServer {

  public static readonly DEFAULT_IP4_HEADER = 20;
  public static readonly DEFAULT_IP6_HEADER = 40;
  public static readonly UDP_HEADER = 8;

  public static readonly MDNS_PORT = 5353;
  public static readonly MDNS_TTL = 255;
  public static readonly MULTICAST_IPV4 = "224.0.0.251";
  public static readonly MULTICAST_IPV6 = "FF02::FB";

  public static readonly SEND_TIMEOUT = 200; // milliseconds

  private readonly handler: PacketHandler;
  private readonly networkManager: NetworkManager;

  private readonly sockets: Map<InterfaceName, Socket> = new Map();
  private readonly sentPackets: Map<InterfaceName, string[]> = new Map();

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
      excludeIpv6: options && options.disableIpv6,
      excludeIpv6Only: true, // we currently have no udp6 sockets advertising anything, thus no need to manage interface which only have ipv6
    });

    this.networkManager.on(NetworkManagerEvent.NETWORK_UPDATE, this.handleUpdatedNetworkInterfaces.bind(this));
  }

  public getNetworkManager(): NetworkManager {
    return this.networkManager;
  }

  public getBoundInterfaceNames(): IterableIterator<InterfaceName> {
    return this.sockets.keys();
  }

  public async bind(): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot rebind closed server!");
    }

    // RFC 6762 15.1. suggest that we probe if we are not the only socket.
    // though as ciao will probably always be installed besides an existing mdns responder, we just assume that without probing
    // As it only affects probe queries, impact isn't that big.
    this.suppressUnicastResponseFlag = true;

    // wait for the first network interfaces to be discovered
    await this.networkManager.waitForInit();

    const promises: Promise<void>[] = [];

    for (const [name, networkInterface] of this.networkManager.getInterfaceMap()) {
      const socket = this.createDgramSocket(name, true);

      const promise = this.bindSocket(socket, networkInterface, IPFamily.IPv4)
        .catch(reason => {
          // TODO if bind errors we probably will never bind again
          console.log("Could not bind detected network interface: " + reason.stack);
        });
      promises.push(promise);
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

  public sendQueryBroadcast(query: DNSQueryDefinition | DNSProbeQueryDefinition, service: CiaoService): Promise<TimedSendResult[]> {
    const packets = DNSPacket.createDNSQueryPackets(query);
    if (packets.length > 1) {
      debug("Query broadcast is split into %d packets!", packets.length);
    }

    const promises: Promise<TimedSendResult[]>[] = [];
    for (const packet of packets) {
      promises.push(this.sendOnAllNetworksForService(packet, service));
    }

    return Promise.all(promises).then((values: TimedSendResult[][]) => {
      const results: TimedSendResult[] = [];

      for (const value of values) { // replace with .flat method when we have node >= 11.0.0 requirement
        results.concat(value);
      }

      return results;
    });
  }

  public sendResponseBroadcast(response: DNSResponseDefinition, service: CiaoService): Promise<TimedSendResult[]> {
    const packet = DNSPacket.createDNSResponsePacketsFromRRSet(response);
    return this.sendOnAllNetworksForService(packet, service);
  }

  public sendResponse(response: DNSPacket, endpoint: EndpointInfo, callback?: SendCallback): void;
  public sendResponse(response: DNSPacket, interfaceName: InterfaceName, callback?: SendCallback): void;
  public sendResponse(response: DNSPacket, endpointOrInterface: EndpointInfo | InterfaceName, callback?: SendCallback): void {
    this.send(response, endpointOrInterface).then(result => {
      if (result.status === "rejected") {
        if (callback) {
          callback(new Error("Encountered socket error on " + result.reason.name + ": " + result.reason.message));
        } else {
          MDNSServer.logSocketError(result.interface, result.reason);
        }
      } else if (callback) {
        callback();
      }
    });
  }

  private sendOnAllNetworksForService(packet: DNSPacket, service: CiaoService): Promise<TimedSendResult[]> {
    this.checkUnicastResponseFlag(packet);

    const message = packet.encode();
    this.assertBeforeSend(message, IPFamily.IPv4);

    const promises: Promise<TimedSendResult>[] = [];
    for (const [name, socket] of this.sockets) {
      if (!service.advertisesOnInterface(name)) {
        // i don't like the fact that we put the check inside the MDNSServer, as it should be independent of the above layer.
        // Though I think this is currently the easiest approach.
        continue;
      }

      const promise = new Promise<SendResult>(resolve => {
        socket.send(message, MDNSServer.MDNS_PORT, MDNSServer.MULTICAST_IPV4, error => {
          if (error) {
            if (!MDNSServer.isSilencedSocketError(error)) {
              resolve({
                status: "rejected",
                interface: name,
                reason: error,
              });
              return;
            }
          } else {
            this.maintainSentPacketsInterface(name, message);
          }

          resolve({
            status: "fulfilled",
            interface: name,
          });
        });
      });

      promises.push(Promise.race([
        promise,
        PromiseTimeout(MDNSServer.SEND_TIMEOUT).then(() =>
          <SendTimeoutResult>{
            status: "timeout",
            interface: name,
          }),
      ]));
    }

    return Promise.all(promises);
  }

  public send(packet: DNSPacket, endpointOrInterface: EndpointInfo | InterfaceName): Promise<SendResult> {
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
    if (!socket) {
      throw new InterfaceNotFoundError(`Could not find socket for given network interface '${name}'`);
    }

    return new Promise<SendResult>(resolve => {
      socket!.send(message, port, address, error => {
        if (error) {
          if (!MDNSServer.isSilencedSocketError(error)) {
            resolve({
              status: "rejected",
              interface: name,
              reason: error,
            });
            return;
          }
        } else {
          this.maintainSentPacketsInterface(name, message);
        }

        resolve({
          status: "fulfilled",
          interface: name,
        });
      });
    });
  }

  private checkUnicastResponseFlag(packet: DNSPacket): void {
    if (this.suppressUnicastResponseFlag && packet.type === PacketType.QUERY) {
      packet.questions.forEach(record => record.unicastResponseFlag = false);
    }
  }

  private assertBeforeSend(message: Buffer, family: IPFamily): void {
    if (this.closed) {
      throw new ServerClosedError("Cannot send packets on a closed mdns server!");
    }
    assert(this.bound, "Cannot send packets before server is not bound!");

    const ipHeaderSize = family === IPFamily.IPv4? MDNSServer.DEFAULT_IP4_HEADER: MDNSServer.DEFAULT_IP6_HEADER;

    // RFC 6762 17.
    assert(ipHeaderSize + MDNSServer.UDP_HEADER + message.length <= 9000,
      "DNS cannot exceed the size of 9000 bytes even with IP Fragmentation!");
  }

  private maintainSentPacketsInterface(name: InterfaceName, packet: Buffer): void {
    const base64 = packet.toString("base64");
    const packets = this.sentPackets.get(name);
    if (!packets) {
      this.sentPackets.set(name, [base64]);
    } else {
      packets.push(base64);
    }
  }

  private checkIfPreviouslySentPacketOnLoopbackInterface(name: InterfaceName, packet: Buffer): boolean {
    const base64 = packet.toString("base64");
    const packets = this.sentPackets.get(name);
    if (packets) {
      const index = packets.indexOf(base64);
      if (index !== -1) {
        packets.splice(index, 1);
        return true;
      }
    }

    return false;
  }

  private createDgramSocket(name: InterfaceName, reuseAddr = false, type: "udp4" | "udp6" = "udp4"): Socket {
    const socket = dgram.createSocket({
      type: type,
      reuseAddr: reuseAddr,
    });

    socket.on("message", this.handleMessage.bind(this, name));
    socket.on("error", error => {
      if (!MDNSServer.isSilencedSocketError(error)) {
        MDNSServer.logSocketError(name, error);
      }
    });

    return socket;
  }

  private bindSocket(socket: Socket, networkInterface: NetworkInterface, family: IPFamily): Promise<void> {
    return new Promise((resolve, reject) => {
      const errorHandler = (error: Error): void => reject(new Error("Failed to bind on interface " + networkInterface.name + ": " + error.message));
      socket.once("error", errorHandler);

      socket.on("close", () => {
        this.sockets.delete(networkInterface.name);
      });

      socket.bind(MDNSServer.MDNS_PORT, () => {
        socket.setRecvBufferSize(800*1024); // setting max recv buffer size to 800KiB (Pi will max out at 352KiB)
        socket.removeListener("error", errorHandler);

        const multicastAddress = family === IPFamily.IPv4? MDNSServer.MULTICAST_IPV4: MDNSServer.MULTICAST_IPV6;
        const interfaceAddress = family === IPFamily.IPv4? networkInterface.ipv4: networkInterface.ipv6;
        assert(interfaceAddress, "Interface address for " + networkInterface.name + " cannot be undefined!");

        try {
          socket.addMembership(multicastAddress, interfaceAddress!);

          socket.setMulticastInterface(interfaceAddress!);

          socket.setMulticastTTL(MDNSServer.MDNS_TTL); // outgoing multicast datagrams
          socket.setTTL(MDNSServer.MDNS_TTL); // outgoing unicast datagrams

          socket.setMulticastLoopback(true); // We can't disable multicast loopback, as otherwise queriers on the same host won't receive our packets

          this.sockets.set(networkInterface.name, socket);
          resolve();
        } catch (error) {
          try {
            socket.close();
          } catch (error) {
            debug("Error while closing socket which failed to bind. Error may be expected: " + error.message);
          }
          reject(new Error("Error binding socket on " + networkInterface.name + ": " + error.stack));
        }
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
    if (this.checkIfPreviouslySentPacketOnLoopbackInterface(networkInterface.name, buffer)) {
      // multicastLoopback is enabled for every interface, meaning we would receive our own response
      // packets here. Thus we silence them. We can't disable multicast loopback, as otherwise
      // queriers on the same host won't receive our packets
      return;
    }

    const ip4Netaddress = getNetAddress(rinfo.address, networkInterface.ip4Netmask!);
    if (ip4Netaddress !== networkInterface.ipv4Netaddress) {
      // This isn't a problem on macOS (it seems like to respect the desired interface we supply for our membership)
      // On Linux based system such filtering seems to not happen :thinking: we just get any traffic and it's like
      // we are just bound to 0.0.0.0
      /* disabled debug message for now
      if (!name.includes("lo")) { // exclude the loopback interface for this error
        debug("Received packet on " + name + " which is not coming from the same subnet. %o",
          {address: rinfo.address, netaddress: ip4Netaddress, interface: networkInterface.ipv4});
      }
      */
      return;
    }

    let packet: DNSPacket;
    try {
      packet = DNSPacket.decode(rinfo, buffer);
    } catch (error) {
      debug("Received a malformed packet from %o on interface %s. This might or might not be a problem. " +
        "Here is the received packet for debugging purposes '%s'. " +
        "Packet decoding failed with %s", rinfo, name, buffer.toString("base64"), error.stack);
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
      try {
        this.handler.handleQuery(packet, endpoint);
      } catch (error) {
        console.warn("Error occurred handling incoming (on " + name + ") dns query packet: " + error.stack);
      }
    } else if (packet.type === PacketType.RESPONSE) {
      if (rinfo.port !== MDNSServer.MDNS_PORT) {
        // RFC 6762 6.  Multicast DNS implementations MUST silently ignore any Multicast DNS responses
        //    they receive where the source UDP port is not 5353.
        return;
      }

      try {
        this.handler.handleResponse(packet, endpoint);
      } catch (error) {
        console.warn("Error occurred handling incoming (on " + name + ") dns response packet: " + error.stack);
      }
    }
  }

  private static isSilencedSocketError(error: Error): boolean {
    // silence those errors
    // they happen when the host is not reachable (EADDRNOTAVAIL for 224.0.0.251 or EHOSTDOWN for any unicast traffic)
    // caused by yet undetected network changes.
    // as we listen to 0.0.0.0 and the socket stays valid, this is not a problem
    const silenced = error.message.includes("EADDRNOTAVAIL") || error.message.includes("EHOSTDOWN")
      || error.message.includes("ENETUNREACH") || error.message.includes("EHOSTUNREACH")
      || error.message.includes("EPERM") || error.message.includes("EINVAL");
    if (silenced) {
      debug ("Silenced and ignored error (This is/should not be a problem, this message is only for informational purposes): " + error.message);
    }
    return silenced;
  }

  private static logSocketError(name: InterfaceName, error: Error): void {
    console.warn(`Encountered MDNS socket error on socket '${name}' : ${error.stack}`);
    return;
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

        this.bindSocket(socket, networkInterface, IPFamily.IPv4).catch(reason => {
          // TODO if bind errors we probably will never bind again
          console.log("Could not bind detected network interface: " + reason.stack);
        });
      }
    }
  }

}
