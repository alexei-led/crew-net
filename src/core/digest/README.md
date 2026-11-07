# digest

`compose(snapshot, me, nowMs) → Digest` and `renderText(digest) → string`. Pure.

Sections: open PRs and owners (mine first), PRs merged since the last session (flagged when they touch files on my branches, listed first), radar findings, unread messages, unanswered requests in both directions with age (oldest first), and plain `@` mentions kept apart. Bot PRs are dropped. Empty sections are not rendered.
