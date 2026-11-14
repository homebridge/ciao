import { ERR_INTERFACE_NOT_FOUND, ERR_NAME_LIMIT_EXCEEDED, errorMessage, errorStack, InterfaceNotFoundError, NameLimitExceededError } from "./errors";

describe("errors", () => {

  it("should name an InterfaceNotFoundError by its exported code", () => {
    expect(new InterfaceNotFoundError("socket gone").name).toBe(ERR_INTERFACE_NOT_FOUND);
  });

  it("should name a NameLimitExceededError by its exported code", () => {
    expect(new NameLimitExceededError("name too long").name).toBe(ERR_NAME_LIMIT_EXCEEDED);
  });

  it("should read the message of an Error, and the text of any other thrown value", () => {
    expect(errorMessage(new Error("socket gone"))).toBe("socket gone");
    expect(errorMessage("a thrown string")).toBe("a thrown string");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("should read the stack of an Error, its message where it holds no stack, and the text of any other thrown value", () => {
    const error = new Error("socket gone");

    expect(errorStack(error)).toBe(error.stack);

    error.stack = undefined;
    expect(errorStack(error)).toBe("socket gone");
    expect(errorStack(42)).toBe("42");
  });

});
