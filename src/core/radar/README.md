# radar

Turns git facts for one branch pair into findings. Deterministic, no LLM. Pure.

`classify(pair, config) → Finding[]`

- `conflict`: merge-tree not clean, with the conflicting paths. Blocking.
- `overlap`: paths changed on both branches.
- `contract-path`: paths the other PR changed that match a contract glob. Blocking. Defaults: `api/openapi/**`, `**/*migration*`, `.github/workflows/**`.
- Nothing for same-developer pairs or bot authors (`renovate`, `dependabot`, `github-actions`, with or without `[bot]`).

`matchGlob`: `**` crosses `/`, `*` stays in one segment, and a glob that matches a parent directory matches everything below it, as in `.gitignore`. No other syntax.
