# Draft gate

For workflows where expensive jobs should wait until a PR is ready, set the PR
trigger types and add this condition to each job:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  build:
    if: github.event.pull_request.draft == false
```

Skipped jobs satisfy required checks. Use this only if that is acceptable for
your ruleset. Keep cheap checks such as `pr-body-keywords` and `crew-deps`
ungated, so they also run on drafts.
