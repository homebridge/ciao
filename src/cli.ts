import {ServiceType} from "./CiaoService";
import {createResponder} from "./index";

// TODO remove this file, it's only used for testing currently

const responder = createResponder();
const service = responder.createService({
  name: "My Accessory",
  type: ServiceType.HAP,
  port: 1234,
  txt: {
    md: "My Accessory",
    pv: "1.1",
    id: "A1:00:0A:92:7D:1D",
    "c#": "1",
    "s#": "1",
    "ff": "0",
    "ci": 11,
    "sf": "1", // "sf == 1" means "discoverable by HomeKit iOS clients"
    "sh": "aaaaaa",
  },
});
service.advertise();


const responder2 = createResponder();
const service2 = responder2.createService({
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
service2.advertise();

const exitHandler = (signal: number) => {
  Promise.all([responder.shutdown(), responder2.shutdown()])
    .then(() => {
      process.exit(128 + signal);
    });
};

process.on("SIGINT", exitHandler.bind(undefined, 2));
process.on("SIGTERM", exitHandler.bind(undefined, 15));


