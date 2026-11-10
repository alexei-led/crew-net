// Runs a command with a time limit: `bun scripts/guard.ts <seconds> <command> [args...]`.
// At the limit it kills the command and every process under it. `bun test
// --parallel` puts each worker in its own process group, and a worker stuck in
// a busy loop ignores bun's per-test timeout, so killing the command alone or
// its group leaves the worker spinning. Killing the tree fails the run instead.
import { execFileSync, spawn } from "node:child_process";

/** Exit code at the limit, as coreutils `timeout` uses. */
export const TIMED_OUT = 124;

/** root and all its descendants, from one `ps` snapshot. */
function tree(root: number): number[] {
  const children = new Map<number, number[]>();
  const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  });
  for (const line of ps.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++)
    out.push(...(children.get(out[i] as number) ?? []));
  return out;
}

const [limit, command, ...args] = process.argv.slice(2);
const seconds = Number(limit);
if (command === undefined || !(seconds > 0)) {
  console.error("usage: bun scripts/guard.ts <seconds> <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit" });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(
    `guard: ${command} ran over ${seconds}s and was killed. Something is stuck: run each test file alone with \`bun test <file>\` to find it.`,
  );
  if (child.pid === undefined) return;
  // One snapshot, then kill: a child reparented by its parent's death is still on the list.
  for (const pid of tree(child.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}, seconds * 1000);

child.on("error", (error) => {
  console.error(`guard: ${command}: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exit(timedOut ? TIMED_OUT : (code ?? 1));
});
