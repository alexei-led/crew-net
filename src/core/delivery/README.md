# delivery

Decides what to do with one inbound item now. Pure; the mod bundles it.

`decide(item, signals, settings, nowMs) → "hold" | "inject" | "wake" | "band"`

| Session | Item                                 | Action                                |
| ------- | ------------------------------------ | ------------------------------------- |
| Active  | addressed or blocking                | `inject` (context on the next prompt) |
| Active  | anything else                        | `hold`                                |
| Idle    | addressed or blocking, auto-wake on  | `wake`                                |
| Idle    | addressed or blocking, auto-wake off | `inject`                              |
| Idle    | anything else, and every digest      | `band`                                |

Active: non-empty draft, or a `prompt.edit` or user `prompt.submit` less than N
minutes ago (default 10). A draft therefore never coexists with a wake. Every
action also shows the item in the band; the mod does that.
