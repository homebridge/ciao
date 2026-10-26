// Names held as strings use the DNS presentation form of RFC 1035 5.1, restricted to the escapes ciao needs: a dot inside a label is written "\." and a
// backslash "\\", so one string can carry a label holding a dot or a backslash, as an RFC 6763 4.1.1 instance name may.

/**
 * Splits a name in presentation form into its raw labels, the empty root label last for a name that ends with the root, which is the array the label coder
 * encodes. A backslash quotes the character after it, so "\." and "\\" give a literal dot and backslash and "\X" gives X. A name holding no backslash
 * takes the native split, so it costs what a plain split costs.
 *
 * @param name - The name in presentation form.
 * @throws When the name ends with an escaped dot, since such a name has no root label.
 */
export function splitLabels(name: string): string[] {
  if (!name.includes("\\")) {
    return name.split(".");
  }

  const labels: string[] = [];
  let label = "";

  for (let i = 0; i < name.length; i++) {
    const char = name.charAt(i);

    if (char === "\\") {
      label += name.charAt(++i);
    } else if (char === ".") {
      labels.push(label);
      label = "";
    } else {
      label += char;
    }
  }

  labels.push(label);

  // An unescaped final dot leaves the empty root label last, so a name ending with a dot and a filled last label ends with an escaped dot.
  if (name.endsWith(".") && label !== "") {
    throw new Error("The name '" + name + "' ends with an escaped dot, so it has no root label.");
  }

  return labels;
}

/**
 * Writes one raw label in presentation form, a backslash before each dot and each backslash. A label holding neither comes back unchanged.
 *
 * @param label - The raw label.
 */
export function escapeLabel(label: string): string {
  if (!label.includes(".") && !label.includes("\\")) {
    return label;
  }

  let escaped = "";

  for (const char of label) {
    escaped += (char === "." || char === "\\")? "\\" + char: char;
  }

  return escaped;
}

/**
 * The octets a name takes on the wire without compression, read from its raw labels: one length octet and the UTF-8 bytes of each label, and one octet for
 * the empty root label. It is the figure the label coder's uncompressed length computes for the same name.
 *
 * @param labels - The raw labels, as {@link splitLabels} returns them.
 */
export function wireLength(labels: string[]): number {
  let length = 0;

  for (const label of labels) {
    length += label? 1 + Buffer.byteLength(label): 1;
  }

  return length;
}
