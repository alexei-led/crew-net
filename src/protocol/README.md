# protocol

The language shared across machines and processes: state block grammar, closing-keyword guard, `crew → dev/name` address grammar, helper↔mod event schema, and version tags.

Pure TypeScript: no I/O, no `node:` imports, no clock. The mod bundles it.

## Public interface

| Export                                     | What it does                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `parseStateBlock(body)`                    | Reads the first `<!-- crew-net v1 ... -->` block. `null` when absent; `unsupported-version` or `malformed` results otherwise. Never throws |
| `renderStateBlock(state)`                  | Writes a block. Refuses a closing keyword or a value that would break the comment                                                          |
| `replaceStateBlock(body, state)`           | Replaces the block in place or appends one; other text is untouched; refuses to overwrite a higher major version                           |
| `findClosingKeywords(text)`                | GitHub's nine closing keywords with `#N`, `owner/repo#N`, `GH-N` or an issue URL; scans HTML comments; mirrors reflex's `check-pr-body.py` |
| `parseAddress(line)`                       | `crew → maria/orion` or `crew → maria` (also `->`) to `{ developer, name? }`, else `null`                                                  |
| `encodeEvent(event)` / `decodeEvent(line)` | NDJSON helper↔mod events `{"v":1,"type":...}`. Decoding returns `ok`, `unknown-version` or `malformed`, never throws                       |

## Rules

- Readers are tolerant: unknown fields are ignored. Writers are strict.
- A new optional field or event is a minor change. A new required field needs `v2`.
- A reader that sees a higher major version reports it and does not write that block.
- `fixtures/events/*.json` holds one event per file, one file per event type (three for `item`, one per kind). Consumers compact each file to one NDJSON line. The helper and mod contract tests read the same files, so a schema change breaks both or neither.
