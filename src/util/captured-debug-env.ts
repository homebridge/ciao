/**
 * The value of `DEBUG` as it stood before the `debug` package was loaded.
 *
 * ⚠️ This module must be imported before `debug` anywhere it is used, and
 * `src/index.ts` does exactly that - see the import-order test in
 * `captured-debug-env.spec.ts`, which exists because nothing else would catch a
 * reorder.
 *
 * `debug` initialises itself with `enable(load())`, and its node implementation of
 * `save()` does `delete process.env.DEBUG` for any falsy value. So an explicitly
 * empty `DEBUG` is *erased* the moment `debug` loads, and from then on it is
 * indistinguishable from `DEBUG` never having been set. That is what made the
 * opt-out added for homebridge/ciao#72 silently do nothing: the helper was correct,
 * but by the time it ran the value it needed was already gone.
 *
 * Capturing it here is the only way to tell the two apart, because after `debug`
 * has loaded the information no longer exists anywhere in the process.
 */
export const capturedDebugEnv: string | undefined = process.env.DEBUG;
