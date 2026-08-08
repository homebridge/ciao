import "source-map-support/register"; // registering node-source-map-support for typescript stack traces
// ⚠️ MUST stay above the `debug` import: loading `debug` deletes an empty DEBUG from
// the environment, so the value has to be read before that happens. Pinned by the
// import-order test in util/captured-debug-env.spec.ts (homebridge/ciao#72).
import { capturedDebugEnv } from "./util/captured-debug-env";
import createDebug from "debug";
import { prereleaseDebugNamespaces } from "./util/prerelease-debug";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const version: string = require("../package.json").version;
// enable debug output if beta version or running bonjour conformance testing,
// unless DEBUG is explicitly set to empty to decline it
const prereleaseNamespaces = prereleaseDebugNamespaces(version, capturedDebugEnv, !!process.env.BCT);
if (prereleaseNamespaces) {
  createDebug.enable(prereleaseNamespaces);
}

import "./coder/records/index";
import { Responder, ResponderOptions } from "./Responder";

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
export function getResponder(options?: ResponderOptions): Responder {
  return Responder.getResponder(options);
}

export default  {
  getResponder: getResponder,
};
