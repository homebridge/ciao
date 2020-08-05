import { sortedInsert } from "./sorted-array";

const compareNum = function (a: number, b: number): number {
  return a - b;
};

describe("sorted-array", () => {
  it("should insert correctly", () => {
    const array: number[] = [];//[1,5,7,9,15,18,20];

    sortedInsert(array, 7, compareNum);
    expect(array).toEqual([7]);

    sortedInsert(array, 5, compareNum);
    expect(array).toEqual([5, 7]);

    sortedInsert(array, 1, compareNum);
    expect(array).toEqual([1, 5, 7]);

    sortedInsert(array, 18, compareNum);
    expect(array).toEqual([1, 5, 7, 18]);

    sortedInsert(array, 9, compareNum);
    expect(array).toEqual([1, 5, 7, 9, 18]);

    sortedInsert(array, 15, compareNum);
    expect(array).toEqual([1, 5, 7, 9, 15, 18]);

    sortedInsert(array, 20, compareNum);
    expect(array).toEqual([1, 5, 7, 9, 15, 18, 20]);

    sortedInsert(array, 20, compareNum);
    expect(array).toEqual([1, 5, 7, 9, 15, 18, 20, 20]);

    sortedInsert(array, 1, compareNum);
    expect(array).toEqual([1, 1, 5, 7, 9, 15, 18, 20, 20]);

    sortedInsert(array, 9, compareNum);
    expect(array).toEqual([1, 1, 5, 7, 9, 9, 15, 18, 20, 20]);

    sortedInsert(array, 10, compareNum);
    expect(array).toEqual([1, 1, 5, 7, 9, 9, 10, 15, 18, 20, 20]);
  });
});
