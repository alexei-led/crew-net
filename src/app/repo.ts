import type { JsonValue, RepoRef } from "../ports/index";

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const isSegment = (part: string): boolean =>
  SEGMENT.test(part) && part !== "." && part !== "..";

/** Repo names are case-insensitive on GitHub; the store keys them in lower case. */
export function refFromSlug(host: string, slug: string): RepoRef | undefined {
  const [owner, name, ...more] = slug.toLowerCase().split("/");
  if (!owner || !name || more.length > 0) return undefined;
  if (!isSegment(host.toLowerCase()) || !isSegment(owner) || !isSegment(name))
    return undefined;
  return { host: host.toLowerCase(), owner, name };
}

/** `host/owner/name`, the form sessions and the watched list carry. */
export function refFromKey(key: string): RepoRef | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0) return undefined;
  return refFromSlug(key.slice(0, slash), key.slice(slash + 1));
}

export const repoKey = (ref: RepoRef): string =>
  `${ref.host}/${ref.owner}/${ref.name}`;

/** `owner/name`, what GitHubPort takes. */
export const repoSlug = (ref: RepoRef): string => `${ref.owner}/${ref.name}`;

export const sameRepo = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Round-trip a typed value into the store's JSON type, dropping undefined fields. */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
