// @ts-expect-error TS7016: a text import of a JS file; bun bundles it as a string.
import crewDepsScript from "../../../repo-kit/scripts/crew-deps.mjs" with {
  type: "text",
};
import config from "../../../repo-kit/templates/crew-net.yml" with {
  type: "text",
};
import crewDeps from "../../../repo-kit/workflows/crew-deps.yml" with {
  type: "text",
};
import crewDepsRerun from "../../../repo-kit/workflows/crew-deps-rerun.yml" with {
  type: "text",
};
import type { InitKit } from "../../app/commands/write/index";

/** The repo kit, bundled into dist/crew-net.js so `init` needs no checkout. */
export const KIT: InitKit = {
  config,
  crewDeps,
  crewDepsRerun,
  crewDepsScript: crewDepsScript as string,
};
