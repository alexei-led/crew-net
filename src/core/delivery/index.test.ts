import { describe, expect, test } from "bun:test";
import {
  type Action,
  type DeliveryItem,
  type DeliverySettings,
  decide,
  type SessionSignals,
} from "./index";

const NOW = 10_000_000;
const MIN = 60_000;
const ask: DeliveryItem = { kind: "ask", wakeable: true };
const idle: SessionSignals = { starting: false, draft: "", turnRunning: false };
const sig = (over: Partial<SessionSignals>): SessionSignals => ({
  ...idle,
  ...over,
});

const WAKE: Action[] = ["band", "wake"];
const NEXT: Action[] = ["band", "inject-next-prompt"];

describe("decide", () => {
  const cases: [
    string,
    DeliveryItem,
    SessionSignals,
    Partial<DeliverySettings>,
    Action[],
  ][] = [
    ["idle ask wakes", ask, idle, {}, WAKE],
    ...(["review", "fix", "bug"] as const).map(
      (kind): [string, DeliveryItem, SessionSignals, object, Action[]] => [
        `idle ${kind} wakes`,
        { kind, wakeable: true },
        idle,
        {},
        WAKE,
      ],
    ),
    ...(
      [
        "info",
        "reply",
        "comment",
        "review-comment",
        "finding",
        "unblocked",
        "dependency-closed",
      ] as const
    ).map((kind): [string, DeliveryItem, SessionSignals, object, Action[]] => [
      `idle ${kind} never wakes`,
      { kind, wakeable: true },
      idle,
      {},
      NEXT,
    ]),
    ["starting: digest", ask, sig({ starting: true }), {}, ["digest"]],
    [
      "starting beats active",
      ask,
      sig({ starting: true, draft: "x", turnRunning: true }),
      {},
      ["digest"],
    ],
    ["draft present", ask, sig({ draft: "wip" }), {}, NEXT],
    ["whitespace draft is empty", ask, sig({ draft: " \n" }), {}, WAKE],
    [
      "user prompt 9 min ago",
      ask,
      sig({ lastUserPromptMs: NOW - 9 * MIN }),
      {},
      NEXT,
    ],
    [
      "typing just under 10 min ago is active",
      ask,
      sig({ lastTypingMs: NOW - (10 * MIN - 1) }),
      {},
      NEXT,
    ],
    [
      "typing exactly 10 min ago is idle",
      ask,
      sig({ lastTypingMs: NOW - 10 * MIN }),
      {},
      WAKE,
    ],
    [
      "custom idle minutes",
      ask,
      sig({ lastTypingMs: NOW - 4 * MIN }),
      { idleMinutes: 3 },
      WAKE,
    ],
    ["turn running", ask, sig({ turnRunning: true }), {}, NEXT],
    [
      "during a wake turn (plugin turn, no user prompt)",
      ask,
      sig({ turnRunning: true, lastWakeAtMs: NOW - 20 * MIN }),
      {},
      NEXT,
    ],
    ["auto-wake off", ask, idle, { autoWake: "off" }, NEXT],
    [
      "routed to a session in another repo",
      { kind: "ask", wakeable: false },
      idle,
      {},
      NEXT,
    ],
    ["woke 9 min ago", ask, sig({ lastWakeAtMs: NOW - 9 * MIN }), {}, NEXT],
    [
      "woke exactly 10 min ago",
      ask,
      sig({ lastWakeAtMs: NOW - 10 * MIN }),
      {},
      WAKE,
    ],
    [
      "wake cooldown ignores idle minutes",
      ask,
      sig({ lastWakeAtMs: NOW - 5 * MIN }),
      { idleMinutes: 3 },
      NEXT,
    ],
  ];

  test.each(cases)("%s", (_name, item, signals, settings, expected) => {
    expect(decide(item, signals, settings, NOW)).toEqual(expected);
  });

  test("undefined settings from parsed config fall back to the defaults", () => {
    const settings = JSON.parse(
      '{"idleMinutes":null,"autoWake":null}',
    ) as Partial<DeliverySettings>;
    expect(
      decide(ask, sig({ lastTypingMs: NOW - MIN }), settings, NOW),
    ).toEqual(NEXT);
    expect(decide(ask, idle, settings, NOW)).toEqual(WAKE);
  });

  test("never wakes with a draft, for any kind and setting", () => {
    for (const kind of ["ask", "review", "fix", "bug", "info", "finding"]) {
      for (const autoWake of ["reply", "off"] as const) {
        expect(
          decide(
            { kind, wakeable: true },
            sig({ draft: "x" }),
            { autoWake },
            NOW,
          ),
        ).not.toContain("wake");
      }
    }
  });
});
