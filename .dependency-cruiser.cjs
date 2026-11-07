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
      name: "plugin-only-depends-on-delivery-trust-protocol",
      severity: "error",
      from: { path: "^plugin/", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "^(plugin/|src/protocol/|src/core/(delivery|trust)/)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
