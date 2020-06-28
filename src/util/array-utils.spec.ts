import { applyDifference, arrayDifference, removeFromArray } from "./array-utils";

describe("array-utils", () => {
  it("should remove from array", () => {
    const array = [1, 2, 3, 4, 5];
    const array2 = ["asdf", "asdf2", "asdf4"];

    removeFromArray(array, [2, 3, 4]);
    removeFromArray(array2, "asdf2");
    removeFromArray(array2, "asdf6");

    expect(array).toEqual([1, 5]);
    expect(array2).toEqual(["asdf", "asdf4"]);
  });

  it("should calc array difference", () => {
    const array = [1, 2, 3, 4, 5];
    const array2 = [1, 3, 5, 6, 7];

    const difference = arrayDifference(array, array2);
    expect(difference).toEqual({
      removed: [2, 4],
      added: [6, 7],
    });
  });

  it("should apply difference", () => {
    const array = [1, 2, 3, 4, 5];
    const array2 = [1, 3, 5, 6, 7];

    const difference = arrayDifference(array, array2);
    applyDifference(array, difference);
    expect(array).toEqual(array2);
  });
});
