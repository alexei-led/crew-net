import { repoSlug } from "../../app/repo";
import { renderStats, stats as statsOf } from "../../app/views";
import type { Command } from "../command";
import { locate, print } from "./shared";

export const stats: Command = {
  name: "stats",
  summary: "What crew-net found and delivered, per repo and week",
  usage: "Usage: crew-net stats [--json] [--repo owner/repo]",
  spec: { values: [], switches: [] },
  async run(ctx) {
    const ports = ctx.runtime.ports();
    let rows = statsOf(await ports.store.events.read());
    if (ctx.repo) {
      const { here } = await locate(ctx, ports);
      const slug = here ? repoSlug(here.ref) : ctx.repo.toLowerCase();
      rows = rows.filter((r) => r.repo.toLowerCase() === slug);
    }
    print(ctx, rows, renderStats(rows));
    return 0;
  },
};
