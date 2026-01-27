import { Prober } from "./Prober";
import { CiaoService, ServiceState } from "../CiaoService";
import { MDNSServer } from "../MDNSServer";
import { Responder } from "../Responder";

describe("Prober", () => {
  describe("checkLocalConflicts", () => {
    // Helper to create a minimal mock service with the required methods
    function createMockService(fqdn: string, hostname: string): Partial<CiaoService> {
      return {
        getFQDN: () => fqdn,
        getLowerCasedFQDN: () => fqdn.toLowerCase(),
        getLowerCasedHostname: () => hostname.toLowerCase(),
        serviceState: ServiceState.UNANNOUNCED,
        incrementName: jest.fn(),
      };
    }

    // Helper to create a mock responder
    function createMockResponder(announcedServices: Partial<CiaoService>[]): Partial<Responder> {
      return {
        getAnnouncedServices: () => announcedServices.values() as IterableIterator<CiaoService>,
      };
    }

    // Helper to create a minimal mock MDNSServer
    function createMockServer(): Partial<MDNSServer> {
      return {};
    }

    it("should NOT detect conflict when services share hostname but have different FQDNs (issue #20)", () => {
      // This is the bug fix test case:
      // Per RFC 6762/6763, multiple services on the same host CAN share a hostname
      // because they share the same A/AAAA records. Only the FQDN must be unique.

      // Existing announced service: "Printer._hap._tcp.local." with hostname "mydevice.local."
      const announcedService = createMockService(
        "printer._hap._tcp.local.",
        "mydevice.local.",
      );

      // New service being probed: "Queue._http._tcp.local." with SAME hostname "mydevice.local."
      const probingService = createMockService(
        "queue._http._tcp.local.",
        "mydevice.local.",
      );

      const responder = createMockResponder([announcedService]);
      const server = createMockServer();

      const prober = new Prober(
        responder as Responder,
        server as MDNSServer,
        probingService as CiaoService,
      );

      // Access the private method for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prober as any).checkLocalConflicts();

      // incrementName should NOT have been called since hostname sharing is allowed
      expect(probingService.incrementName).not.toHaveBeenCalled();
    });

    it("should detect conflict when services have the same FQDN", () => {
      // Two services with identical FQDN is a real conflict that should trigger rename

      // Existing announced service
      const announcedService = createMockService(
        "printer._hap._tcp.local.",
        "mydevice.local.",
      );

      // New service being probed with SAME FQDN (this is a conflict)
      const probingService = createMockService(
        "printer._hap._tcp.local.",
        "otherdevice.local.",
      );

      const responder = createMockResponder([announcedService]);
      const server = createMockServer();

      const prober = new Prober(
        responder as Responder,
        server as MDNSServer,
        probingService as CiaoService,
      );

      // Access the private method for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prober as any).checkLocalConflicts();

      // incrementName SHOULD have been called since FQDN conflict is real
      expect(probingService.incrementName).toHaveBeenCalled();
    });

    it("should NOT detect conflict when services have different FQDNs and different hostnames", () => {
      // Completely different services - no conflict

      const announcedService = createMockService(
        "printer._hap._tcp.local.",
        "printer.local.",
      );

      const probingService = createMockService(
        "scanner._http._tcp.local.",
        "scanner.local.",
      );

      const responder = createMockResponder([announcedService]);
      const server = createMockServer();

      const prober = new Prober(
        responder as Responder,
        server as MDNSServer,
        probingService as CiaoService,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prober as any).checkLocalConflicts();

      expect(probingService.incrementName).not.toHaveBeenCalled();
    });

    it("should handle multiple announced services correctly", () => {
      // Multiple services already announced, new service shares hostname with one

      const announcedService1 = createMockService(
        "service1._hap._tcp.local.",
        "mydevice.local.",
      );
      const announcedService2 = createMockService(
        "service2._http._tcp.local.",
        "mydevice.local.",
      );

      // New service with same hostname as both existing services but different FQDN
      const probingService = createMockService(
        "service3._ipp._tcp.local.",
        "mydevice.local.",
      );

      const responder = createMockResponder([announcedService1, announcedService2]);
      const server = createMockServer();

      const prober = new Prober(
        responder as Responder,
        server as MDNSServer,
        probingService as CiaoService,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prober as any).checkLocalConflicts();

      // Should NOT rename - sharing hostname is allowed
      expect(probingService.incrementName).not.toHaveBeenCalled();
    });
  });
});
