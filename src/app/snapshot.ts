import type { RepoRef } from "../ports/index";
import { snapshotPull, writeSnapshot } from "./files";
import type { AppPorts } from "./ports";
import { repoSlug } from "./repo";

/** Repo state job (design §8.2): open PRs with their parsed state blocks. ETags make an unchanged list free. */
export async function snapshotJob(
  ports: AppPorts,
  ref: RepoRef,
): Promise<void> {
  const pulls = await ports.github(ref.host).listOpenPulls(repoSlug(ref));
  await writeSnapshot(ports.store, ref, {
    fetchedAtMs: ports.clock.now(),
    pulls: pulls.map(snapshotPull),
  });
}
