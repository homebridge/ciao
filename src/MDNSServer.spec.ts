import { MDNSServer, SendResultFailedRatio } from "./MDNSServer";

describe(MDNSServer, () => {
  it("SendResultFailedRatio", () => {
    expect(SendResultFailedRatio([
      { status: "fulfilled", interface: "eth0", value: undefined},
      { status: "fulfilled", interface: "eth0", value: undefined},
      { status: "fulfilled", interface: "eth0", value: undefined},
      { status: "fulfilled", interface: "eth0", value: undefined},
      { status: "fulfilled", interface: "eth0", value: undefined},
    ])).toBe(0);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0", value: undefined},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "fulfilled", interface: "eth0", value: undefined},
      { status: "fulfilled", interface: "eth0", value: undefined},
    ])).toBe(0.4);

    expect(SendResultFailedRatio([
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
      { status: "rejected", interface: "eth0", reason: new Error()},
    ])).toBe(1);

    expect(SendResultFailedRatio([])).toBe(0);
  });
});
