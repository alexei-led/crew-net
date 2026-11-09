import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { FilesPort } from "../../ports/index";

function absolute(path: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("Path must be absolute");
  return path;
}

/** Working-tree files on the local filesystem. */
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

  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(absolute(path)), { recursive: true });
    await writeFile(path, content, { mode: 0o644 });
  }
}
