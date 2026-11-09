import type { SessionHeartbeat, SessionRole } from "../ports/index";
import { touchWatched } from "./files";
import type { AppPorts } from "./ports";
import { refFromSlug, repoKey } from "./repo";
import { worktreeOf } from "./worktree";

export interface BeatInput {
  sessionId: string;
  harness: string;
  role: SessionRole;
  /** Process id of the harness session. */
  pid: number;
  /** Working directory of the session. */
  dir: string;
  /** True when the beat comes from a submitted user prompt. */
  prompt?: boolean;
}

/**
 * Write a session heartbeat (design §8.3): the repo, branch and clone of
 * the working copy that holds `dir`, so routing can find it (§9.3). Git
 * resolves the paths, so a subdirectory or a symlinked path names its
 * worktree. Keeps the last prompt time unless
 * this beat is a prompt. Marks the repo watched.
 */
export async function beat(
  ports: AppPorts,
  input: BeatInput,
): Promise<SessionHeartbeat> {
  const { store, clock } = ports;
  const identity = await ports.env
    .repoIdentity(input.dir)
    .catch(() => undefined);
  const ref = identity ? refFromSlug(identity.host, identity.repo) : undefined;
  const wt = await worktreeOf(ports.git(input.dir));
  const previous = (await store.sessions.live()).find(
    (s) => s.sessionId === input.sessionId,
  );
  const lastPromptAtMs = input.prompt ? clock.now() : previous?.lastPromptAtMs;
  const heartbeat: SessionHeartbeat = {
    sessionId: input.sessionId,
    pid: input.pid,
    harness: input.harness,
    role: input.role,
    worktree: wt?.root ?? input.dir,
    ...(wt ? { clone: wt.clone } : {}),
    ...(ref ? { repo: repoKey(ref) } : {}),
    ...(wt?.branch ? { branch: wt.branch } : {}),
    ...(lastPromptAtMs !== undefined ? { lastPromptAtMs } : {}),
  };
  await store.sessions.beat(heartbeat);
  if (ref) await touchWatched(store, [repoKey(ref)], clock.now());
  return heartbeat;
}

/** A clean session end: the session is no longer a routing target. */
export async function end(ports: AppPorts, sessionId: string): Promise<void> {
  await ports.store.sessions.remove(sessionId);
}
