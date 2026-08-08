import { readFileSync } from "fs";
import { join } from "path";

// Regression (homebridge/ciao#72): the DEBUG= opt-out shipped in 1.3.11-beta.2 did
// nothing, because `debug` deletes an empty DEBUG from the environment as it loads
// and the import of `debug` runs before the code that reads it. Capturing the value
// first is the only available fix, which makes the *order* of two imports
// load-bearing - and nothing else in the suite would notice if they were swapped.
//
// TypeScript emits requires in source order, so asserting on the source is enough to
// pin the behaviour of the built output.
describe("index.ts import order", () => {
  const source = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

  function lineOf(pattern: RegExp): number {
    const index = source.split("\n").findIndex(line => pattern.test(line));
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
  }

  it("captures DEBUG before the debug package is loaded", () => {
    const capture = lineOf(/^import .*captured-debug-env/);
    const debugImport = lineOf(/^import createDebug from "debug"/);

    expect(capture).toBeLessThan(debugImport);
  });
});

describe("capturedDebugEnv", () => {
  it("is read once, at module load, rather than on each access", async () => {
    // A getter re-reading process.env would defeat the whole point, since the value
    // is gone by the time anything asks for it.
    const before = process.env.DEBUG;
    try {
      const { capturedDebugEnv } = await import("./captured-debug-env");
      const captured = capturedDebugEnv;

      process.env.DEBUG = "changed-after-load";
      const { capturedDebugEnv: readAgain } = await import("./captured-debug-env");

      expect(readAgain).toBe(captured);
    } finally {
      if (before === undefined) {
        delete process.env.DEBUG;
      } else {
        process.env.DEBUG = before;
      }
    }
  });
});
