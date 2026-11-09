import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  await files.write(path, "a: 1\n", root);
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
  await expect(files.exists("rel/x")).rejects.toThrow("absolute");
  await expect(files.write("rel/x", "", "/")).rejects.toThrow("absolute");
});

test("a symlinked folder cannot take a write outside the tree", async () => {
  const root = temp();
  const outside = temp();
  symlinkSync(outside, join(root, ".github"));
  await expect(
    new FilesAdapter().write(join(root, ".github", "x.yml"), "a", root),
  ).rejects.toThrow("outside the working tree");
  expect(existsSync(join(outside, "x.yml"))).toBe(false);
});

test("a symlink at the file name is never written through", async () => {
  const root = temp();
  const outside = temp();
  const victim = join(outside, "victim");
  writeFileSync(victim, "keep");
  symlinkSync(victim, join(root, "crew-net.yml"));
  await expect(
    new FilesAdapter().write(join(root, "crew-net.yml"), "new", root),
  ).rejects.toThrow();
  expect(readFileSync(victim, "utf8")).toBe("keep");
});
