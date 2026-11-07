# trust

What an inbound item may cause, how peer text is framed, and which tool calls a wake turn may make. Pure; the mod bundles it.

- `allowedEffects(source)`: peer text may only `reply` or `propose-own-state`.
- `frameUntrusted(text, { from, pr? })`: labelled block naming sender and PR; the end marker inside text is defused.
- `wakeToolPolicy({ tool, command? }) → allow | deny(reason)`: fail closed.
  - Allowed tools: `Read`, `Glob`, `Grep`, `LS`. Everything else, including `Edit`, `Write`, `NotebookEdit`, is denied.
  - `Bash` must be one simple command: `crew-net post|state|inbox|digest`, `gh pr view|list|diff|checks`, `gh api` with GET and no body flags (not `graphql`), `git log|show|diff|status|fetch` without a leading option or an output or exec flag.
  - Any `;`, `&`, `|`, `<`, `>`, parentheses, newline, backtick or `$(` outside single quotes is denied. Quoted text such as a `crew-net post "a; b"` message is fine.
