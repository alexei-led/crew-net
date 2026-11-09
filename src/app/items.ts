import type { StorePort } from "../ports/index";
import type { ItemEvent } from "../protocol/index";

/** GitHub accepts ISO 8601 without milliseconds; stored cursors use one format so they compare as strings. */
export const iso = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Peer text kept in the store; the digest and the mod cap it further. */
export const ITEM_TEXT_MAX = 4000;

export const sameLogin = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Write an item once, and log it. An id already in the inbox is left as it
 * is: a killed sync re-reads from its old cursor and must not rewrite what a
 * session already has. The caller moves its cursor only after this resolves.
 */
export async function putItem(
  store: StorePort,
  item: ItemEvent,
  nowMs: number,
): Promise<boolean> {
  if ((await store.inbox.get(item.id)) !== undefined) return false;
  await store.inbox.put(item);
  await store.events.append({
    type: "item",
    id: item.id,
    event: item.event ?? item.kind,
    ...(item.repo ? { repo: item.repo } : {}),
    atMs: nowMs,
  });
  return true;
}

const REF = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;

/** A `depends-on` entry made explicit: `owner/repo#N`, lower case. Undefined when it is not a PR ref. */
export function resolveRef(
  ref: string,
  repo: string,
): { repo: string; number: number; key: string } | undefined {
  const m = REF.exec(ref.trim());
  if (!m) return undefined;
  const target = (m[1] ?? repo).toLowerCase();
  const number = Number(m[2]);
  return { repo: target, number, key: `${target}#${number}` };
}
