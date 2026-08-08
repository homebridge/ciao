/**
 * Works out which debug namespaces a prerelease build should switch on for itself.
 *
 * A beta enables ciao's own debug output so that a bug report arrives with a useful
 * log already attached, without asking the reporter to set anything. That is worth
 * keeping, but it has to be declinable: the enable covers `ciao:*`, which includes
 * the namespaces the probe and announce retries log to, so a consumer pinning a beta
 * could not get a quiet console at all - and could not test that they would get one
 * on the stable release either (homebridge/ciao#72).
 *
 * The old check was `if (!debug)`, and an empty string is falsy, so `DEBUG=` read
 * identically to DEBUG being unset. An explicitly empty DEBUG now means "no thanks".
 *
 * @param version - the running package version
 * @param debugEnv - the raw `DEBUG` environment variable, undefined when unset
 * @param conformanceTesting - whether `BCT` is set (bonjour conformance testing)
 * @returns the namespaces to pass to debug's `enable`, or null to leave it alone
 */
export function prereleaseDebugNamespaces(
  version: string,
  debugEnv: string | undefined,
  conformanceTesting: boolean,
): string | null {
  if (!version.includes("beta") && !conformanceTesting) {
    return null;
  }

  if (debugEnv === undefined) { // nothing configured, so turn ours on
    return "ciao:*";
  }

  if (debugEnv === "") { // set but empty: an explicit opt-out
    return null;
  }

  if (debugEnv.includes("ciao")) { // already asked for ours, leave their setting alone
    return null;
  }

  return `${debugEnv},ciao:*`;
}
