import { describe, expect, test } from "bun:test";
import { parseAddress } from "./index";

describe("parseAddress", () => {
  test.each([
    ["crew → maria/orion", { developer: "maria", name: "orion" }],
    ["crew → maria", { developer: "maria" }],
    ["crew -> maria/orion", { developer: "maria", name: "orion" }],
    ["crew -> maria", { developer: "maria" }],
    ["crew → Maria-Dev/lead-2", { developer: "Maria-Dev", name: "lead-2" }],
    ["  crew → maria/orion  ", { developer: "maria", name: "orion" }],
    [
      "crew → maria/orion\nDoes #2310 need the column?",
      { developer: "maria", name: "orion" },
    ],
  ])("accepts %j", (line, expected) => {
    expect(parseAddress(line)).toEqual(expected);
  });

  test.each([
    "",
    "crew",
    "crew →",
    "crew → ",
    "crew → /orion",
    "crew → maria/",
    "crew → maria/Orion",
    "crew → maria/or ion",
    "crew → maria/orion/extra",
    "crew → -maria",
    "crew → ma ria",
    `crew → ${"a".repeat(40)}`,
    "crew → maria please look",
    "Crew → maria",
    "hello crew → maria",
    "\ncrew → maria",
    "@maria can you look?",
  ])("rejects %j", (line) => {
    expect(parseAddress(line)).toBeNull();
  });
});
