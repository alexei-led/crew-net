import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  doctor as check,
  type DoctorProbes,
  renderDoctor,
} from "../../app/doctor";
import type { Command } from "../command";
import { locate, print } from "./shared";

/** Claude Code lists installed plugins in `installed_plugins.json`, keyed `name@marketplace`. */
export function pluginState(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): "installed" | "missing" | "unknown" {
  const config =
    env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)
      ? env.CLAUDE_CONFIG_DIR
      : join(home, ".claude");
  let text: string;
  try {
    text = readFileSync(
      join(config, "plugins", "installed_plugins.json"),
      "utf8",
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unknown";
  }
  try {
    const parsed = JSON.parse(text) as { plugins?: Record<string, unknown> };
    const names = Object.keys(parsed.plugins ?? parsed);
    return names.some((n) => n.startsWith("crew-net@"))
      ? "installed"
      : "missing";
  } catch {
    return "unknown";
  }
}

function repoProbes(root: string | undefined): Omit<DoctorProbes, "plugin"> {
  const inside = (path: string) => {
    if (!root) return undefined;
    const full = normalize(join(root, path));
    return full.startsWith(`${root}/`) ? full : undefined;
  };
  return {
    async readRepoFile(path) {
      const full = inside(path);
      if (!full) return undefined;
      try {
        return readFileSync(full, "utf8");
      } catch {
        return undefined;
      }
    },
    async listRepoDir(path) {
      const full = inside(path);
      if (!full) return [];
      try {
        return readdirSync(full);
      } catch {
        return [];
      }
    },
  };
}

export const doctor: Command = {
  name: "doctor",
  summary:
    "Check gh, token, hooks policy, plugin and repo setup; name the next step",
  usage: "Usage: crew-net doctor [--json] [--repo owner/repo]",
  spec: { values: [], switches: [] },
  async run(ctx) {
    const ports = ctx.runtime.ports();
    const { here, root } = await locate(ctx, ports);
    const report = await check(
      ports,
      {
        plugin: async () => pluginState(process.env, homedir()),
        ...repoProbes(root),
      },
      here,
    );
    print(ctx, report, renderDoctor(report));
    return report.checks.some((c) => c.status === "fail") ? 1 : 0;
  },
};
