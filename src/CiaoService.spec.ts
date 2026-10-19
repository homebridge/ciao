import { CiaoService, ServiceOptions } from "./CiaoService";
import { RType } from "./coder/DNSPacket";
import { NetworkManager } from "./NetworkManager";

function addressNSECTypes(options: Partial<ServiceOptions> = {}): RType[] {
  const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
  const service = new CiaoService(networkManager, {
    name: "Test Service",
    type: "http",
    port: 4711,
    ...options,
  });
  service.rebuildServiceRecords();

  const types: RType[] = [];
  for (const window of service.addressNSECRecord().rrTypeWindows) {
    types.push(...window.rrtypes);
  }
  return types;
}

describe(CiaoService, () => {
  describe("addressNSECRecord", () => {
    it("should assert A and AAAA records", () => {
      expect(addressNSECTypes()).toStrictEqual([RType.A, RType.AAAA]);
    });

    it("should not assert AAAA records when IPv6 is disabled", () => {
      // RFC 6762 6.1.: the bitmap lists the types which do exist for the name. Listing AAAA
      // without having such a record leaves a querier waiting for an answer that never comes.
      expect(addressNSECTypes({ disabledIpv6: true })).toStrictEqual([RType.A]);
    });
  });
});
