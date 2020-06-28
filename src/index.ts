import "./coder/records/index";
import {Responder} from "./Responder";
import {MDNSServerOptions} from "./MDNSServer";

export * from "./CiaoService";
export * from "./MDNSServer";
export * from "./Responder";

/**
 * Defines the transport protocol of a service.
 *
 * As of RFC 6763 7. TCP must be used for any applications using tcp.
 *  For applications using any other transport protocol UDP must be used.
 *  This applies to all other transport protocols like SCTP, DCCP, RTMFP, etc
 */
export const enum Protocol {
  TCP = "tcp",
  UDP = "udp",
}


export const enum IPFamily {
  IPv4 = "IPv4",
  IPv6 = "IPv6",
}

export function createResponder(options?: MDNSServerOptions): Responder {
  return new Responder(options);
}

export default  {
  createResponder: createResponder,
};
