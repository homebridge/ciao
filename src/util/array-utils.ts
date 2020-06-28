export function removeFromArray<T>(array: T[], element: T): void
export function removeFromArray<T>(array: T[], element: T[]): void
export function removeFromArray<T>(array: T[], element: T | T []): void {
  if (Array.isArray(element)) {
    for (const element0 of element) {
      removeFromArray(array, element0);
    }
  } else {
    const index = array.indexOf(element);
    if (index >= 0) {
      array.splice(index, 1);
    }
  }
}

export interface ArrayDifference<T> {
  removed: T[];
  added: T[];
}

export function arrayDifference<T>(base: T[] | undefined = [], newArray: T[] | undefined = []): ArrayDifference<T> {
  return {
    removed: base.filter(element => !newArray.includes(element)),
    added: newArray.filter(element => !base.includes(element)),
  };
}

export function applyDifference<T>(array: T[], difference: ArrayDifference<T>): void {
  removeFromArray(array, difference.removed);
  array.push(...difference.added);
}
