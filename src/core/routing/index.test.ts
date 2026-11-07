import { describe, expect, test } from "bun:test";
import {
  type LeadFacts,
  type PullFacts,
  type Route,
  type RoutedMessage,
  route,
} from "./index";

const lead = (address: string, over: Partial<LeadFacts> = {}): LeadFacts => ({
  address,
  developer: address.split("/")[0] ?? "",
  leaseLive: true,
  lastActiveMs: 0,
  work: [],
  ...over,
});

const pull = (number: number, over: Partial<PullFacts> = {}): PullFacts => ({
  number,
  author: "maria",
  branch: `b${number}`,
  changedPaths: [],
  ...over,
});

const toMaria = (pr?: number): RoutedMessage =>
  pr === undefined
    ? { address: { developer: "maria" } }
    : { address: { developer: "maria" }, pr };

describe("route to developer", () => {
  const cases: [string, RoutedMessage, Parameters<typeof route>[1], Route][] = [
    [
      "step 1: comment on her PR goes to the state-block lead, lease or not",
      toMaria(10),
      {
        pulls: [pull(10, { lead: "maria/orion" })],
        leads: [
          lead("maria/orion", { leaseLive: false }),
          lead("maria/vega", { lastActiveMs: 99 }),
        ],
      },
      { lead: "maria/orion", step: "state-block" },
    ],
    [
      "step 1 wins over overlap and recency",
      toMaria(10),
      {
        pulls: [pull(10, { lead: "maria/orion", changedPaths: ["a.ts"] })],
        leads: [
          lead("maria/vega", {
            lastActiveMs: 99,
            work: [{ branch: "x", changedPaths: ["a.ts"] }],
          }),
        ],
      },
      { lead: "maria/orion", step: "state-block" },
    ],
    [
      "step 1 ignores a state-block lead of another developer",
      toMaria(10),
      {
        pulls: [pull(10, { lead: "alexei/atlas" })],
        leads: [lead("maria/vega")],
      },
      { lead: "maria/vega", step: "recent-lease" },
    ],
    [
      "step 2: PR by someone else, lead with overlapping worktree path",
      toMaria(20),
      {
        pulls: [pull(20, { author: "alexei", changedPaths: ["api/a.yaml"] })],
        leads: [
          lead("maria/orion", { lastActiveMs: 50 }),
          lead("maria/vega", {
            lastActiveMs: 1,
            work: [{ branch: "feat", changedPaths: ["api/a.yaml", "z"] }],
          }),
        ],
      },
      { lead: "maria/vega", step: "overlap" },
    ],
    [
      "step 2: same branch counts as overlap, no lease needed",
      toMaria(20),
      {
        pulls: [pull(20, { author: "alexei", branch: "shared" })],
        leads: [
          lead("maria/vega", {
            leaseLive: false,
            work: [{ branch: "shared", changedPaths: [] }],
          }),
          lead("maria/orion", { lastActiveMs: 50 }),
        ],
      },
      { lead: "maria/vega", step: "overlap" },
    ],
    [
      "step 2: several overlapping leads, most recently active wins",
      toMaria(20),
      {
        pulls: [pull(20, { author: "alexei", changedPaths: ["p"] })],
        leads: [
          lead("maria/a", {
            lastActiveMs: 1,
            work: [{ branch: "x", changedPaths: ["p"] }],
          }),
          lead("maria/b", {
            lastActiveMs: 2,
            work: [{ branch: "y", changedPaths: ["p"] }],
          }),
        ],
      },
      { lead: "maria/b", step: "overlap" },
    ],
    [
      "step 3: no overlap, most recent live lease",
      toMaria(20),
      {
        pulls: [pull(20, { author: "alexei", changedPaths: ["p"] })],
        leads: [
          lead("maria/a", { lastActiveMs: 5 }),
          lead("maria/b", { lastActiveMs: 9, leaseLive: false }),
          lead("maria/c", { lastActiveMs: 7 }),
        ],
      },
      { lead: "maria/c", step: "recent-lease" },
    ],
    [
      "step 3: comment not on a PR",
      toMaria(),
      { pulls: [], leads: [lead("maria/a", { lastActiveMs: 5 })] },
      { lead: "maria/a", step: "recent-lease" },
    ],
    [
      "step 3: unknown PR number",
      toMaria(404),
      { pulls: [], leads: [lead("maria/a")] },
      { lead: "maria/a", step: "recent-lease" },
    ],
    [
      "step 3: equal activity breaks the tie on address",
      toMaria(),
      { pulls: [], leads: [lead("maria/b"), lead("maria/a")] },
      { lead: "maria/a", step: "recent-lease" },
    ],
    [
      "step 4: no live lease waits",
      toMaria(20),
      {
        pulls: [pull(20, { author: "alexei" })],
        leads: [lead("maria/a", { leaseLive: false })],
      },
      { wait: true },
    ],
    [
      "step 4: no leads at all waits",
      toMaria(),
      { pulls: [], leads: [] },
      { wait: true },
    ],
    [
      "other developers' leads are never picked",
      toMaria(),
      { pulls: [], leads: [lead("alexei/atlas", { lastActiveMs: 99 })] },
      { wait: true },
    ],
    [
      "logins compare case-insensitively",
      { address: { developer: "Maria" } },
      { pulls: [], leads: [lead("maria/a")] },
      { lead: "maria/a", step: "recent-lease" },
    ],
  ];
  test.each(cases)("%s", (_name, message, facts, expected) => {
    expect(route(message, facts)).toEqual(expected);
  });
});

describe("route to developer/name", () => {
  const msg: RoutedMessage = { address: { developer: "maria", name: "orion" } };
  const cases: [string, LeadFacts[], Route][] = [
    [
      "lead holds a lease",
      [lead("maria/orion"), lead("maria/vega", { lastActiveMs: 99 })],
      { lead: "maria/orion", step: "named" },
    ],
    [
      "lease expired: wait, never fall back to a sibling",
      [lead("maria/orion", { leaseLive: false }), lead("maria/vega")],
      { wait: true },
    ],
    ["name nobody holds", [lead("maria/vega")], { wait: true }],
  ];
  test.each(cases)("%s", (_name, leads, expected) => {
    expect(route(msg, { pulls: [], leads })).toEqual(expected);
  });
});
