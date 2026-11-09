# protocol

The language shared across machines and processes (design §7, §10.1, §14): state block, message marker, closing-keyword guard, repo config subset, and watcher↔mod events.

Pure TypeScript: no I/O, no `node:` imports, no clock. The mod bundles it.

## Public interface

| Export                                                | What it does                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseStateBlock(body)`                               | Reads the first `<!-- crew-net ... -->` block (also the old `<!-- crew-net v1 ... -->` form; `lead` ignored). `null` only when no block opens. A bad value is skipped and listed in `warnings`. Never throws |
| `renderStateBlock(state)`                             | Writes the unversioned block. Refuses a closing keyword or a value that would break the comment                                                                                                              |
| `replaceStateBlock(body, state)`                      | Replaces the block in place or appends one; keeps the existing block's unknown fields; refuses a block that never closes                                                                                     |
| `findClosingKeywords(text)`                           | GitHub's closing keywords with `#N`, `owner/repo#N`, `GH-N` or an issue URL (`github.com`, `www.github.com`, `*.ghe.com`); scans HTML comments; mirrors reflex's `check-pr-body.py`                          |
| `parseMessageMarker(body)` / `renderMessageMarker(m)` | `<!-- crew-net:msg kind=… id=… re=… status=… -->` at the start of a comment. `null` when there is no marker; `malformed` for an unknown kind, bad id or missing required key                                 |
| `mentionLine(login, text)`                            | The visible first line, `@login text`; `null` for a bad login or empty text                                                                                                                                  |
| `parseRepoConfig(text)`                               | `.github/crew-net.yml` subset: `contracts`, `deploy-branches`, `bots`, `early-drafts`, `agents-merge`. Defaults from design §10.1; an error with the line for syntax it cannot read                          |
| `encodeEvent(event)` / `decodeEvent(line)`            | NDJSON watcher↔mod events `{"type":...}`. Decoding returns `ok` or `malformed`, never throws                                                                                                                 |

## Rules

- The GitHub protocol has no version number. Readers ignore unknown fields and treat missing ones as empty; writers keep fields they do not know. New fields must be optional.
- A state block in either format never parses as `null`. The order gate reads `null` as "no dependencies".
- A bad `depends-on` ref is dropped from `dependsOn` and reported in `warnings`. Callers that enforce order (`core/order`, `repo-kit/crew-deps.mjs`) must treat that warning as a failure.
- `<!-- crew-net:msg` is not a state block: the block tag must be followed by whitespace or `-->`.
- A message marker counts only at the start of a comment, so a quoted marker in a person's reply is not a request.
- `fixtures/events/*.json` holds one event per file, one file per event type (three for `item`, one per kind). Consumers compact each file to one NDJSON line. The watcher and mod contract tests read the same files, so a schema change breaks both or neither.
- `repo-kit/scripts/crew-deps.mjs` carries a dependency-free copy of the state block reader. `repo-kit/crew-deps.test.ts` checks it against `parseStateBlock`.

## Repo config subset

Block mappings, block lists, one-line `[a, b]` lists, plain and quoted scalars, `#` comments. Flow maps, anchors, tags, multi-line scalars and tabs are refused. Unknown keys are ignored. Without `contracts`, the default contract applies: producers `**/migrations/**`, `**/*migration*`, `api/openapi/**`, `**/*.proto`; consumers: any other path.
