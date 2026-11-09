import type { RepoRef, ThreadState } from "../ports/index";
import { snapshotPull, writeSnapshot } from "./files";
import { putItem } from "./items";
import type { AppPorts } from "./ports";
import { repoKey, repoSlug } from "./repo";

/**
 * Repo state job (design §8.2): open PRs with their parsed state blocks.
 * ETags make an unchanged list free. Then closes my requests whose thread
 * closed or merged.
 */
export async function snapshotJob(
  ports: AppPorts,
  ref: RepoRef,
): Promise<void> {
  const pulls = await ports.github(ref.host).listOpenPulls(repoSlug(ref));
  await writeSnapshot(ports.store, ref, {
    fetchedAtMs: ports.clock.now(),
    pulls: pulls.map((p) => snapshotPull(p, repoSlug(ref))),
  });
  await closeRequests(ports, ref, new Set(pulls.map((p) => p.number)));
}

/**
 * A request is closed when its thread is closed or merged (design §7.3).
 * Only threads that are not open PRs are read. The item that tells me is
 * written before the request leaves the outbox; it shows in the digest until
 * a session delivers it. A thread that cannot be read is retried next pass.
 */
async function closeRequests(
  ports: AppPorts,
  ref: RepoRef,
  openPulls: ReadonlySet<number>,
): Promise<void> {
  const { store, clock } = ports;
  const key = repoKey(ref);
  const slug = repoSlug(ref);
  for (const request of await store.outbox.list()) {
    if (request.repo.toLowerCase() !== key || openPulls.has(request.number))
      continue;
    let state: ThreadState;
    try {
      state = await ports.github(ref.host).threadState(slug, request.number);
    } catch (error) {
      await store.events.append({
        type: "sync-error",
        job: `repo:${key}`,
        request: request.id,
        message: error instanceof Error ? error.message : String(error),
        atMs: clock.now(),
      });
      continue;
    }
    if (state === "open") continue;
    const nowMs = clock.now();
    const thread = `#${request.number}`;
    await putItem(
      store,
      {
        type: "item",
        id: `request-closed:${key}${thread}:${request.id}`,
        kind: "message",
        text: `your ${request.kind} to ${request.to} on ${thread} is closed: ${thread} ${state === "merged" ? "merged" : "was closed"}`,
        addressed: false,
        repo: slug,
        thread: request.number,
        event: "request-closed",
      },
      nowMs,
    );
    await store.outbox.remove(request.id);
    await store.events.append({
      type: "request",
      id: request.id,
      repo: request.repo,
      kind: request.kind,
      outcome: `thread-${state}`,
      openMs: nowMs - request.createdAtMs,
      atMs: nowMs,
    });
  }
}
