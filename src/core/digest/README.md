# digest

The session-start digest (design §5.1). Pure.

`compose(input, nowMs) → Digest` (the model, for `--json`) and
`renderText(digest) → string` (the band, the terminal and the model). The text
form is shown in [design §5.1](../../../docs/design.md#51-session-start).

| Section | Source                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| You     | My open PRs: state (block, else `draft` or `open`), scope, `depends-on` with status. Then "waits on your #N" for PRs that depend on mine     |
| Others  | Others' open PRs and bare branches, minus bots. Radar marks (`conflict`, `overlap`, `order`); marked work first. Capped at 8, then `+N more` |
| Merged  | `stale` findings: PRs merged to my base after my merge base that touch my files                                                              |
| Inbox   | Unread inbound items, oldest first                                                                                                           |
| Waiting | My open requests with age, oldest first, so those open over an hour lead                                                                     |

- Empty sections are left out. Nothing to report: one line.
- Findings on work not in `others` (a cross-repo `order`) get their own line.
- Peer text (branches, scopes, paths, messages, kinds) goes through `clean`:
  control characters, newlines and bidi controls become spaces, `"` becomes
  `'` so the text cannot close its quotes, and lengths are capped (120 for
  messages, 60 for labels). Messages are quoted and followed by a framing line.
- PR titles are not shown.
