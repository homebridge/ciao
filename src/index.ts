// eslint-disable-next-line
/// <reference path="../types/dns-packet.d.ts" />
// TODO adjust stuff so we can remove above stuff

/**
 * Defines the transport protocol of a service.
 *
 * As of RFC 6763 7. TCP must be used for any applications using tcp.
 *  For applications using any other transport protocol UDP must be used.
 *  This applies to all other transport protocols like SCTP, DCCP, RTMFP, etc
 */
import {Responder} from "./Responder";
import {ServerOptions} from "./MDNSServer";

export * from "./CiaoService";
export * from "./MDNSServer";
export * from "./Responder";

export const enum Protocol {
  TCP = "tcp",
  UDP = "udp",
}


export const enum IPFamily {
  IPv4 = "IPv4",
  IPv6 = "IPv6",
}

export class Ciao {

  // TODO add more debug
  // TODO add tests

  createResponder(options?: ServerOptions): Responder {
    return new Responder(options);
  }

  // TODO create browser

}

const ciao = new Ciao();

export default ciao;
