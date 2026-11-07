import { describe, expect, test } from "bun:test";
import {
  type Action,
  type DeliveryItem,
  decide,
  type SessionSignals,
} from "./index";

const NOW = 10_000_000;
const MIN = 60_000;
const addressed: DeliveryItem = {
  kind: "message",
  addressed: true,
  blocking: false,
};
const blocking: DeliveryItem = {
  kind: "finding",
  addressed: false,
  blocking: true,
};
const info: DeliveryItem = {
  kind: "message",
  addressed: false,
  blocking: false,
};
const digest: DeliveryItem = {
  kind: "digest",
  addressed: true,
  blocking: true,
};
const idle: SessionSignals = { draft: "" };

type Settings = { autoWake?: boolean; idleMinutes?: number };

describe("decide", () => {
  const cases: [string, DeliveryItem, SessionSignals, Settings, Action][] = [
    ["draft present, addressed", addressed, { draft: "wip" }, {}, "inject"],
    ["draft present, informational", info, { draft: "wip" }, {}, "hold"],
    ["whitespace draft is empty", addressed, { draft: " \n" }, {}, "wake"],
    [
      "recent edit",
      addressed,
      { draft: "", lastEditMs: NOW - 2 * MIN },
      {},
      "inject",
    ],
    [
      "recent user prompt",
      blocking,
      { draft: "", lastUserPromptMs: NOW - 9 * MIN },
      {},
      "inject",
    ],
    [
      "edit just under N is active",
      addressed,
      { draft: "", lastEditMs: NOW - (10 * MIN - 1) },
      {},
      "inject",
    ],
    [
      "edit exactly N ago is idle",
      addressed,
      { draft: "", lastEditMs: NOW - 10 * MIN },
      {},
      "wake",
    ],
    [
      "custom N respected",
      addressed,
      { draft: "", lastEditMs: NOW - 4 * MIN },
      { idleMinutes: 3 },
      "wake",
    ],
    ["idle addressed wakes", addressed, idle, {}, "wake"],
    ["idle blocking wakes", blocking, idle, {}, "wake"],
    [
      "idle addressed, auto-wake off",
      addressed,
      idle,
      { autoWake: false },
      "inject",
    ],
    ["idle informational", info, idle, {}, "band"],
    ["idle digest never wakes", digest, idle, {}, "band"],
    ["active digest is held", digest, { draft: "x" }, {}, "hold"],
    [
      "draft beats idle timers with auto-wake on",
      blocking,
      { draft: "x", lastEditMs: NOW - 60 * MIN },
      { autoWake: true },
      "inject",
    ],
  ];
  test.each(cases)("%s", (_name, item, signals, settings, expected) => {
    expect(decide(item, signals, settings, NOW)).toBe(expected);
  });

  test("never wakes while a draft is present, for any item and setting", () => {
    for (const item of [addressed, blocking, info, digest]) {
      for (const autoWake of [true, false]) {
        expect(decide(item, { draft: "x" }, { autoWake }, NOW)).not.toBe(
          "wake",
        );
      }
    }
  });
});
