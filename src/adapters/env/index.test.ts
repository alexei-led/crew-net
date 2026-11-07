import { expect, test } from "bun:test";
import * as module from "./index";

test("module loads", () => {
  expect(module).toBeDefined();
});
