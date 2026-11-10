import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const guard = join(import.meta.dir, "guard.ts");

function run(
  ...args: string[]
): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guard, ...args]);
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, out, ms: Date.now() - started }),
    );
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("guard", () => {
  test.each([
    [["5", "sh", "-c", "exit 0"], 0],
    [["5", "sh", "-c", "exit 3"], 3],
    [["0", "true"], 2],
    [["5"], 2],
    [["5", "/no/such/command"], 127],
  ])("%j exits %d", async (args, code) => {
    expect((await run(...args)).code).toBe(code);
  });

  // `set -m` gives the background job its own process group, as bun does for test workers.
  test("at the limit it kills every process under the command, in any group, and exits 124", async () => {
    const result = await run(
      "0.5",
      "sh",
      "-c",
      "set -m; sleep 30 & echo $!; wait",
    );
    const grandchild = Number(result.out.split("\n")[0]);
    expect(result.code).toBe(124);
    expect(result.out).toContain("ran over 0.5s");
    expect(result.ms).toBeLessThan(5000);
    expect(alive(grandchild)).toBe(false);
  });
});
