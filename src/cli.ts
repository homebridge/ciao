import { ServiceType } from "./CiaoService";
import ciao from "./index";

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

const responder = ciao.getResponder({
  // interface: ["en0"],
});
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


