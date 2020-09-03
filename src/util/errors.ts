export const ERR_INTERFACE_NOT_FOUND = "ERR_INTERFACE_NOT_FOUND";
export const ERR_SERVER_CLOSED = "ERR_SERVER_CLOSED";

export class InterfaceNotFoundError extends Error {

  constructor(message: string) {
    super(message);
    this.name = "ERR_INTERFACE_NOT_FOUND";
  }

}

export class ServerClosedError extends Error {

  constructor(message: string) {
    super(message);
    this.name = ERR_SERVER_CLOSED;
  }

}
