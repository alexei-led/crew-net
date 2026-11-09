/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "protocol-is-independent",
      severity: "error",
      from: { path: "^src/protocol/", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^src/protocol/" },
    },
    {
      name: "core-only-depends-on-core-and-protocol",
      severity: "error",
      from: { path: "^src/core/", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^src/(core|protocol)/" },
    },
    {
      name: "app-only-depends-on-core-protocol-ports",
      severity: "error",
      from: { path: "^src/app/", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^src/(app|core|protocol|ports)/" },
    },
    {
      name: "adapters-only-depend-on-ports-protocol-and-self",
      severity: "error",
      from: { path: "^src/adapters/([^/]+)/", pathNot: "\\.test\\.ts$" },
      to: {
        path: "^(src|plugin|e2e|repo-kit)/",
        pathNot: "^src/(ports/|protocol/|adapters/$1/)",
      },
    },
    {
      // Design §19 rule 6: the plugin reaches GitHub, git and the store only
      // through crew-net processes. The command-hook script runs in Node and
      // may use Node built-ins; the mod has no Node (next rule).
      name: "plugin-only-depends-on-core-and-protocol",
      severity: "error",
      from: { path: "^plugin/", pathNot: "\\.(test|spec)\\.ts$" },
      to: {
        dependencyTypesNot: ["core"],
        pathNot: "^(plugin/|src/protocol/|src/core/)",
      },
    },
    {
      name: "mod-has-no-node",
      severity: "error",
      from: { path: "^plugin/hooks/(register|mod)\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
