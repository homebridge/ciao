export const ERR_INTERFACE_NOT_FOUND = "ERR_INTERFACE_NOT_FOUND";

export class InterfaceNotFoundError extends Error {

  constructor(message: string) {
    super(message);
    this.name = "ERR_INTERFACE_NOT_FOUND";
  }

}
