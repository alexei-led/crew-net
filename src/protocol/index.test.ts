import { expect, test } from "bun:test";
import {
  decodeEvent,
  encodeEvent,
  findClosingKeywords,
  mentionLine,
  parseMessageMarker,
  parseRepoConfig,
  parseStateBlock,
  renderMessageMarker,
  renderStateBlock,
  replaceStateBlock,
} from "./index";

test("exports the public interface", () => {
  const exported = [
    parseStateBlock,
    renderStateBlock,
    replaceStateBlock,
    findClosingKeywords,
    parseMessageMarker,
    renderMessageMarker,
    mentionLine,
    parseRepoConfig,
    encodeEvent,
    decodeEvent,
  ];
  for (const fn of exported) expect(typeof fn).toBe("function");
});
