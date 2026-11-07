import { expect, test } from "bun:test";
import {
  decodeEvent,
  encodeEvent,
  findClosingKeywords,
  parseAddress,
  parseStateBlock,
  renderStateBlock,
  replaceStateBlock,
} from "./index";

test("exports the public interface", () => {
  const exported = [
    parseStateBlock,
    renderStateBlock,
    replaceStateBlock,
    findClosingKeywords,
    parseAddress,
    encodeEvent,
    decodeEvent,
  ];
  for (const fn of exported) expect(typeof fn).toBe("function");
});
