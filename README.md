# ciao

[![NPM-Version](https://badgen.net/npm/v/@homebridge/ciao)](https://www.npmjs.org/package/@homebridge/ciao)
[![NPM-Downloads](https://badgen.net/npm/dt/@homebridge/ciao)](https://www.npmjs.org/package/@homebridge/ciao)
[![Node-CI](https://github.com/homebridge/ciao/workflows/Node-CI/badge.svg)](https://github.com/homebridge/ciao/actions?query=workflow%3ANode-CI)
[![Coverage Status](https://coveralls.io/repos/github/homebridge/ciao/badge.svg?branch=master)](https://coveralls.io/github/homebridge/ciao?branch=master)

`ciao` is a [RFC 6763](https://tools.ietf.org/html/rfc6763) and compliant `dns-sd` library,
advertised on multicast dns ([RFC 6762](https://tools.ietf.org/html/rfc6762#section-8)).

It is used in [HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) and is the successor of the 
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
responder.start(); // this step will not be needed in the future

// create a service defining a web server running on port 3000
const service = responder.createService({
    name: 'My Web Server',
    type: 'http',
    port: 3000,
    txt: {
      key: "value",
    }
})


service.advertise(); // this method will return a promise in the future
//wait for the advertisment...

// ....

service.updateTxt({
    newKey: "newValue",
});

// ....

// remove advertisement. The service is now UNANNOUNCED.
// But can be advertised again by calling the method metioned above
service.end();
```
