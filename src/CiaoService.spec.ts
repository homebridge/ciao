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

  describe("sharesAddressRecordsWith (#20)", () => {
    beforeEach(() => {
      // an IP address restriction is resolved to the interface holding it, which must not depend on this machine
      jest.spyOn(NetworkManager, "resolveInterface").mockReturnValue("en1");
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function makeService(options: Partial<ServiceOptions> = {}): CiaoService {
      const networkManager = { getInterfaceMap: () => new Map() } as unknown as NetworkManager;
      return new CiaoService(networkManager, { name: "Test Service", type: "http", port: 4711, ...options });
    }

    it("should share when neither service restricts its addresses", () => {
      expect(makeService().sharesAddressRecordsWith(makeService({ type: "ipp" }))).toBe(true);
    });

    it("should share when both restrict to the same addresses, in any order", () => {
      const a = makeService({ restrictedAddresses: ["en0", "192.168.1.2", "192.168.1.3"] });
      const b = makeService({ restrictedAddresses: ["192.168.1.3", "192.168.1.2", "en0"] });
      expect(a.sharesAddressRecordsWith(b)).toBe(true);
    });

    it("should not share when only one service disables IPv6", () => {
      expect(makeService().sharesAddressRecordsWith(makeService({ disabledIpv6: true }))).toBe(false);
    });

    it("should not share when only one service restricts its addresses", () => {
      expect(makeService().sharesAddressRecordsWith(makeService({ restrictedAddresses: ["en0"] }))).toBe(false);
    });

    it("should not share when the services are restricted to different addresses", () => {
      const a = makeService({ restrictedAddresses: ["192.168.1.2"] });
      const b = makeService({ restrictedAddresses: ["192.168.1.3"] });
      expect(a.sharesAddressRecordsWith(b)).toBe(false);
    });
  });
});
