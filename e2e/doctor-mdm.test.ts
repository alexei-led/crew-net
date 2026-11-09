import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvAdapter, type EnvRunner } from "../src/adapters/env/index";
import { FileStoreAdapter } from "../src/adapters/store/index";
import { doctor, renderDoctor } from "../src/app/doctor";
import type { AppPorts } from "../src/app/ports";
import { DEFAULT_SETTINGS } from "../src/app/settings";

// Scenario 8 of docs/plan.md: `doctor` flags an MDM `allowManagedHooksOnly`.
// The CLI reads the policy only from system paths, which need root to plant,
// so this plants a real binary plist and reads it with the real plutil.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** plutil runs for real; gh is "not signed in", so nothing reaches GitHub. */
const runner: EnvRunner = async (command, args) => {
  if (command !== "plutil") return { stdout: "", exitCode: 1 };
  return {
    stdout: execFileSync("plutil", args, { encoding: "utf8" }),
    exitCode: 0,
  };
};

test.skipIf(process.platform !== "darwin")(
  "doctor fails the hooks policy and the merge gate on a planted allowManagedHooksOnly plist",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-net-mdm-"));
    dirs.push(dir);
    const plist = join(dir, "com.anthropic.claudecode.plist");
    execFileSync("plutil", ["-create", "binary1", plist]);
    execFileSync("plutil", [
      "-insert",
      "allowManagedHooksOnly",
      "-bool",
      "YES",
      plist,
    ]);

    const clock = { now: () => Date.now() };
    const ports: AppPorts = {
      store: new FileStoreAdapter(join(dir, "state"), clock),
      clock,
      env: new EnvAdapter({
        repoDir: dir,
        runner,
        policySources: [{ kind: "plist", path: plist }],
      }),
      settings: DEFAULT_SETTINGS,
      settingsProblems: [],
      github: () => {
        throw new Error("doctor must not reach GitHub without a token");
      },
      git: () => {
        throw new Error("no repo here");
      },
    };
    const report = await doctor(
      ports,
      {
        plugin: async () => "installed",
        readRepoFile: async () => undefined,
        listRepoDir: async () => [],
      },
      undefined,
    );

    const text = renderDoctor(report);
    expect(text).toContain(
      "✗ hooks policy: allowManagedHooksOnly is set by MDM",
    );
    expect(text).toContain("✗ merge gate: inactive");
    expect(report.level).toBeNull();
  },
);
