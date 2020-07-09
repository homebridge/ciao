process.env.BCT = "yes"; // set bonjour conformance testing env (used to enable debug output)

import http from "http";
import readline from "readline";
import ciao, { ServiceType } from ".";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

// bct checks if the advertised service also has a tcp socket bound to
const server = http.createServer((req, res) => {
  res.writeHead(200,  "OK");
  res.end("Hello world!\n");
});
server.listen(8085);

const responder = ciao.getResponder();

const service = responder.createService({
  name: "My Test Service",
  port: 8085,
  type: ServiceType.HTTP,
  txt: {
    "test": "key",
    "test2": "key2",
    "ver": 1,
  },
});

server.on("listening", () => {
  service.advertise().then(() => {
    rl.question("What should the service name be changed to? [N to close]: ", answer => {
      if (answer.toLowerCase() === "n") {
        rl.close();
      } else {
        service.updateName(answer);
      }
    });
  });
});

const exitHandler = (signal: number): void => {
  rl.close();

  responder.shutdown().then(() => {
    process.exit(128 + signal);
  });
};
process.on("SIGINT", exitHandler.bind(undefined, 2));
process.on("SIGTERM", exitHandler.bind(undefined, 15));
