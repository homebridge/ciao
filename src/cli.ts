import { CiaoService, ServiceType } from "./CiaoService";
import { ARecord } from "./coder/records/ARecord";
import { createResponder, MDNSServer } from "./index";

// TODO remove this file, it's only used for testing currently

const txt = {
  md: "My Accessory",
  pv: "1.1",
  id: "A1:00:0A:92:7D:1D",
  "c#": "1",
  "s#": "1",
  "ff": "0",
  "ci": 11,
  "sf": "1", // "sf == 1" means "discoverable by HomeKit iOS clients"
  "sh": "aaaaab",
};

function updateRecord(service: CiaoService) {
  setTimeout(() => {
    console.log("Updating record!");
    txt.sf = txt.sf === "1" ? "0" : "1";
    service.updateTxt(txt).then(() => {
      updateRecord(service);
    });
  }, 10000);
}

const responder = createResponder();
const service = responder.createService({
  name: "My Accessory2",
  type: ServiceType.HAP,
  port: 1234,
  txt: txt,
});
/*const serviceCopy = responder.createService({
  name: "My Accessory",
  type: ServiceType.HAP,
  port: 1234,
  txt: {
    md: "My Accessory",
    pv: "1.1",
    id: "A2:00:0A:92:7D:1D",
    "c#": "1",
    "s#": "1",
    "ff": "0",
    "ci": 11,
    "sf": "1", // "sf == 1" means "discoverable by HomeKit iOS clients"
    "sh": "cccccc",
  },
});
*/

service.advertise().then(() => {
  console.log("Advertised service1");

  setTimeout(() => {
    console.log("Sending REMOVAL of A record!");
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const server: MDNSServer = responder.server;

    server.sendResponse({
      answers: [
        new ARecord("My-Accessory2.local.", "192.168.178.62", true, 0),
        new ARecord("My-Accessory2.local.", "192.168.178.66", true, 120),
      ],
    }, "en0");
  }, 20000);
  //updateRecord(service);
  //return serviceCopy.advertise();
});
/*
const responder2 = createResponder();
const service2 = responder.createService({
  name: "My Accessory",
  type: ServiceType.HAP,
  port: 1234,
  txt: {
    md: "My Accessory",
    pv: "1.1",
    id: "B1:00:0A:92:7D:1D",
    "c#": "1",
    "s#": "1",
    "ff": "0",
    "ci": 11,
    "sf": "1", // "sf == 1" means "discoverable by HomeKit iOS clients"
    "sh": "bbbbbb",
  },
});

//service2.advertise();*/

const exitHandler = (signal: number): void => {
  Promise.all([responder.shutdown(),
    //responder2.shutdown(),
  ])
    .then(() => {
      process.exit(128 + signal);
    });
};

process.on("SIGINT", exitHandler.bind(undefined, 2));
process.on("SIGTERM", exitHandler.bind(undefined, 15));


