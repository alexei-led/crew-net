import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesAdapter } from "./index";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-files-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("write creates parent directories and exists sees the file", async () => {
  const root = temp();
  const files = new FilesAdapter();
  const path = join(root, ".github", "workflows", "x.yml");
  expect(await files.exists(path)).toBe(false);
  await files.write(path, "a: 1\n");
  expect(await files.exists(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("a: 1\n");
});

test("a dangling symlink exists", async () => {
  const root = temp();
  const path = join(root, "link");
  symlinkSync(join(root, "missing"), path);
  expect(await new FilesAdapter().exists(path)).toBe(true);
});

test("relative paths are refused", async () => {
  const files = new FilesAdapter();
  expect(files.exists("rel/x")).rejects.toThrow("absolute");
  expect(files.write("rel/x", "")).rejects.toThrow("absolute");
});
