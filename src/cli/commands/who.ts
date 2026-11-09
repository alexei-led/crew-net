import { isAbsolute, relative, resolve } from "node:path";
import { readWatched } from "../../app/files";
import { refFromKey, repoKey } from "../../app/repo";
import { renderWho, who as whoView } from "../../app/views";
import type { RepoRef } from "../../ports/index";
import type { Command } from "../command";
import { locate, print } from "./shared";

export const who: Command = {
  name: "who",
  summary: "Open work in watched repos that touches these paths",
  usage: `Usage: crew-net who [paths...] [--json] [--repo owner/repo]
  Paths are relative to the current directory. Without paths, lists all
  open work by others. Run it before starting work.`,
  spec: { values: [], switches: [] },
  async run(ctx) {
    const ports = ctx.runtime.ports();
    const { here, root } = await locate(ctx, ports);
    const repos = new Map<string, RepoRef>();
    if (here) repos.set(repoKey(here.ref), here.ref);
    if (!ctx.repo) {
      for (const key of Object.keys(await readWatched(ports.store))) {
        const ref = refFromKey(key);
        if (ref) repos.set(key, ref);
      }
    }
    const paths = ctx.args.positional.map((p) => {
      if (!root) return p;
      const rel = relative(root, resolve(ctx.runtime.cwd, p));
      return rel.startsWith("..") || isAbsolute(rel) ? p : rel || ".";
    });
    const entries = await whoView(
      ports.store,
      [...repos.values()],
      paths.map((p) => (p === "." ? "" : p)),
    );
    print(ctx, entries, renderWho(entries));
    return 0;
  },
};
