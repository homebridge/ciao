import { MDNSServer, SendResultFailedRatio } from "./MDNSServer";

describe(MDNSServer, () => {
  it("SendResultFailedRatio", () => {
    expect(SendResultFailedRatio([
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
      { status: "fulfilled", interface: "eth0"},
    ])).toBe(0);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0"},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0"},
      { status: "timeout", interface: "eth0"},
    ])).toBe(0.6);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "timeout", interface: "eth0"},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
    ])).toBe(1);

    expect(SendResultFailedRatio([])).toBe(0);
  });
});
