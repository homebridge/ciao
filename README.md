# ciao

[![NPM-Version](https://badgen.net/npm/v/@homebridge/ciao)](https://www.npmjs.org/package/@homebridge/ciao)
[![NPM-Downloads](https://badgen.net/npm/dt/@homebridge/ciao)](https://www.npmjs.org/package/@homebridge/ciao)
[![Node-CI](https://github.com/homebridge/ciao/workflows/Node-CI/badge.svg)](https://github.com/homebridge/ciao/actions?query=workflow%3ANode-CI)
[![Coverage Status](https://coveralls.io/repos/github/homebridge/ciao/badge.svg?branch=master)](https://coveralls.io/github/homebridge/ciao?branch=master)

`ciao` is a [RFC 6763](https://tools.ietf.org/html/rfc6763) compliant `dns-sd` library,
advertising on multicast dns ([RFC 6762](https://tools.ietf.org/html/rfc6762#section-8))
implemented in plain Typescript/JavaScript.

It is going to be used in [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) and is the successor of the 
[bonjour-hap](https://github.com/homebridge/bonjour) library, 
aiming to be more robust, more maintainable and RFC compliant.

`ciao` features a multicast dns responder to publish service on the local network.
It will gain browser functionality in the future to also discover existing services on the local network.  

The library is currently still under heavy development.

## Installation

```
npm install --save @homebridge/ciao
```

## Usage

```js
const ciao = require("@homebridge/ciao");


const responder = ciao.createResponder();

// create a service defining a web server running on port 3000
const service = responder.createService({
    name: 'My Web Server',
    type: 'http',
    port: 3000,
    txt: { // optional
      key: "value",
    }
})


service.advertise().then(() => {
  // stuff you do when the service is published
  console.log("Service is published :)");
});

// ....

service.updateTxt({
    newKey: "newValue",
});

// ....

service.end().then(() => {
  // service is now UNANNOUNCED and can be published again
});
```

## Documentation 

### MTU

As of [RFC 6762 17. Multicast DNS Message Size](https://tools.ietf.org/html/rfc6762#section-17) DNS packets must avoid
IP Fragmentation and ensure that all sent packets are smaller than the Maximum Transmission Unit (MTU) defined by
the network interface. The MTU defaults to 1500 Bytes on pretty much all network cards for Ethernet and Wi-Fi.
ciao can't reliable detect modifications made to this default MTU size. Thus, if you know, that the MTU
differs on your machine, you can set the true MTU in bytes using the `CIAO_MTU` environment variable. 
