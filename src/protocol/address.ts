/** Who a message is for: a developer, optionally one of their named leads. */
export interface Address {
  developer: string;
  name?: string;
}

/** GitHub login: alphanumerics and hyphens, at most 39 characters. */
export const LOGIN_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
/** Lead name: lowercase letters, digits and dashes. */
export const NAME_PATTERN = "[a-z0-9-]+";

const ADDRESS_LINE = new RegExp(
  `^crew\\s*(?:→|->)\\s*(${LOGIN_PATTERN})(?:/(${NAME_PATTERN}))?$`,
);

/**
 * Parse the first line of a comment, `crew → maria/orion` or `crew → maria`.
 * ASCII `->` is accepted. Later lines are ignored. Returns null when the line
 * is not an address.
 */
export function parseAddress(line: string): Address | null {
  const first = (line.split("\n")[0] ?? "").trim();
  const match = ADDRESS_LINE.exec(first);
  const developer = match?.[1];
  if (developer === undefined) return null;
  const name = match?.[2];
  return name === undefined ? { developer } : { developer, name };
}
