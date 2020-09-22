import "source-map-support/register"; // registering node-source-map-support for typescript stack traces

// eslint-disable-next-line @typescript-eslint/no-var-requires
const version: string = require("../package.json").version;
if (version.includes("beta") || process.env.BCT) { // enable debug output if beta version or running bonjour conformance testing
  const debug = process.env.DEBUG;
  if (!debug || !debug.includes("ciao")) {
    if (!debug) {
      process.env.DEBUG = "ciao:*";
    } else {
      process.env.DEBUG = debug + ",ciao:*";
    }
  }
}

import "./coder/records/index";
import { MDNSServerOptions } from "./MDNSServer";
import { Responder } from "./Responder";
import createDebug from "debug";

export * from "./CiaoService";
export * from "./Responder";
export { MDNSServerOptions } from "./MDNSServer";

function printInitInfo() {
  const debug = createDebug("ciao:init");
  debug("Loading ciao v" + version + "...");
}
printInitInfo();

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

/**
 * This method is used to get a responder for the provided (optional) set of options.
 *
 * Ciao tries to create as few Responder instances as possible.
 * Thus, it will share the same Responder instance for the same set of options.
 *
 * @param options - If specified, the options will be passed to the underlying mdns server.
 * @returns A Responder instance for the given options. Might be shared with others using the same options.
 */
export function getResponder(options?: MDNSServerOptions): Responder {
  return Responder.getResponder(options);
}

export default  {
  getResponder: getResponder,
};
