// node killsync.mjs <laptop> <killAfterMs>: start crew-net sync --once, SIGKILL it after killAfterMs.
import { spawn } from "node:child_process";

const [lap, ms] = process.argv.slice(2);
const W = process.env.W,
  CN = process.env.CN;
const env = {
  ...process.env,
  XDG_STATE_HOME: `${W}/${lap}/state`,
  XDG_CONFIG_HOME: `${W}/${lap}/config`,
  CLAUDE_CONFIG_DIR: `${W}/${lap}/claude`,
  GH_CONFIG_DIR: `${W}/${lap}/gh`,
};
const child = spawn("node", [CN, "sync", "--once", "--json"], {
  cwd: `${W}/${lap}/repo`,
  env,
  stdio: "inherit",
});
const t = setTimeout(() => {
  child.kill("SIGKILL");
  console.log(`killed pid ${child.pid} after ${ms} ms`);
}, Number(ms));
child.on("exit", (code, sig) => {
  clearTimeout(t);
  console.log("exit", code, sig);
});
