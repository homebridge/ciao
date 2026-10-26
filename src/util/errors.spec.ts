import { ERR_INTERFACE_NOT_FOUND, ERR_NAME_LIMIT_EXCEEDED, InterfaceNotFoundError, NameLimitExceededError } from "./errors";

describe("errors", () => {

  it("should name an InterfaceNotFoundError by its exported code", () => {
    expect(new InterfaceNotFoundError("socket gone").name).toBe(ERR_INTERFACE_NOT_FOUND);
  });

  it("should name a NameLimitExceededError by its exported code", () => {
    expect(new NameLimitExceededError("name too long").name).toBe(ERR_NAME_LIMIT_EXCEEDED);
  });

});
