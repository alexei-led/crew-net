// node watch.mjs <laptop> <session> <seconds>: run crew-net watch, print events, SIGKILL it.
import { spawn } from "node:child_process";

const [lap, session, secs] = process.argv.slice(2);
const W = process.env.W,
  CN = process.env.CN;
const dir = `${W}/${lap}/repo`;
const env = {
  ...process.env,
  XDG_STATE_HOME: `${W}/${lap}/state`,
  XDG_CONFIG_HOME: `${W}/${lap}/config`,
  CLAUDE_CONFIG_DIR: `${W}/${lap}/claude`,
  GH_CONFIG_DIR: `${W}/${lap}/gh`,
};
const child = spawn("node", [CN, "watch", "--session", session], {
  cwd: dir,
  env,
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const ev = JSON.parse(line);
    console.log(
      new Date().toTimeString().slice(0, 8),
      ev.type,
      ev.type === "item"
        ? (ev.item?.id ?? ev.id)
        : JSON.stringify(ev).slice(0, 160),
    );
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
  }
});
setTimeout(() => {
  child.kill("SIGKILL");
  console.log("killed");
  process.exit(0);
}, Number(secs) * 1000);
