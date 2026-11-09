// node budget.mjs <seconds>: two watchers on laptop d (sandbox and crew-net clones), every fetch logged.
import { spawn } from "node:child_process";

const W = process.env.W,
  CN = process.env.CN,
  secs = Number(process.argv[2]);
const env = {
  ...process.env,
  XDG_STATE_HOME: `${W}/d/state`,
  XDG_CONFIG_HOME: `${W}/d/config`,
  CLAUDE_CONFIG_DIR: `${W}/d/claude`,
  GH_CONFIG_DIR: `${W}/d/gh`,
  NODE_OPTIONS: `--import ${W}/count.mjs`,
  CREW_E2E_FETCH_LOG: `${W}/d/fetch.log`,
};
const kids = [
  ["sess-d1", `${W}/d/repo`],
  ["sess-d2", `${W}/d/repo2`],
].map(([session, dir]) => {
  const child = spawn("node", [CN, "watch", "--session", session], {
    cwd: dir,
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.on("data", (d) => {
    for (const line of String(d).split("\n").filter(Boolean)) {
      const ev = JSON.parse(line);
      if (ev.type === "ready") {
        child.stdin.write(
          `${JSON.stringify({
            type: "hello",
            session,
            role: "lead",
            harness: "claude-code",
            worktree: dir,
            pid: process.pid,
            settings: { autoWake: false },
          })}\n`,
        );
        child.stdin.end();
      }
      if (ev.type !== "item")
        console.log(
          new Date().toTimeString().slice(0, 8),
          session,
          line.slice(0, 200),
        );
    }
  });
  return child;
});
setTimeout(() => {
  for (const k of kids) k.kill("SIGTERM");
  console.log("done");
  process.exit(0);
}, secs * 1000);
