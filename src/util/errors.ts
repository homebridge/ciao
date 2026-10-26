export const ERR_INTERFACE_NOT_FOUND = "ERR_INTERFACE_NOT_FOUND";
export const ERR_NAME_LIMIT_EXCEEDED = "ERR_NAME_LIMIT_EXCEEDED";

export class InterfaceNotFoundError extends Error {

  constructor(message: string) {
    super(message);
    this.name = ERR_INTERFACE_NOT_FOUND;
  }

}

/**
 * Thrown when a name in a received packet goes beyond the limits a valid name has.
 * Such a packet is dropped as a whole, instead of skipping just the record the name is in.
 */
export class NameLimitExceededError extends Error {

  constructor(message: string) {
    super(message);
    this.name = ERR_NAME_LIMIT_EXCEEDED;
  }

}
