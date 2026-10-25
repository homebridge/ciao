/**
 * The name of the DNS-SD service type enumeration meta query (RFC 6763 9.): a PTR record under
 * this name points at every service type advertised on the network.
 *
 * Kept in a module of its own so CiaoService can use it without importing the Responder, which
 * imports CiaoService - a cycle at load time.
 */
export const SERVICE_TYPE_ENUMERATION_NAME = "_services._dns-sd._udp.local.";
