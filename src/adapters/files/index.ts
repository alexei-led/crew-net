import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import type { FilesPort } from "../../ports/index";

function absolute(path: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Path must be absolute");
  return path;
}

/** True when `path` is `root` or below it, both real paths. */
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
};

/** Working-tree files on the local filesystem. Writes never leave `root` (symlinks included). */
export class FilesAdapter implements FilesPort {
  async exists(path: string): Promise<boolean> {
    try {
      // lstat: a dangling symlink still blocks a write without --force.
      await lstat(absolute(path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async write(path: string, content: string, root: string): Promise<void> {
    const target = absolute(path);
    const rootReal = await realpath(absolute(root));
    // The deepest existing ancestor decides where mkdir would create folders.
    let ancestor = dirname(target);
    while (!(await this.exists(ancestor))) ancestor = dirname(ancestor);
    if (!inside(rootReal, await realpath(ancestor)))
      throw new Error(
        `refusing to write ${path}: it leads outside the working tree`,
      );
    await mkdir(dirname(target), { recursive: true });
    if (!inside(rootReal, await realpath(dirname(target))))
      throw new Error(
        `refusing to write ${path}: it leads outside the working tree`,
      );
    // O_NOFOLLOW: a symlink at the file name fails instead of being written through.
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
  }
}
