# order

`gateDecision(pr, deps, argv) → allow | deny(reasons)`, each with `advisory`. Pure.

- Not `gh pr merge`: allow.
- `gh pr merge` in any form, including `--auto`: deny while a same-repo `depends-on` PR is unmerged or its state is missing from `deps`.
- Malformed or unsupported state block: deny (fail closed). No block: allow.
- Cross-repo refs go to `advisory` and never block.

Not covered: merges through `gh api`.
