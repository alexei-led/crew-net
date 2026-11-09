# Files adapter

`new FilesAdapter()` implements [FilesPort](../../ports/index.ts): files in the
developer's working tree, used by `crew-net init`.

- `exists(path)` uses `lstat`, so a dangling symlink counts as present and is
  not overwritten without `--force`.
- `write(path, content, root)` creates parent directories and replaces the file
  (mode 0644). It refuses a path whose real location is outside `root`, and a
  symlink at the file name (`O_NOFOLLOW`).
- Paths must be absolute. The caller decides what to write and whether to
  overwrite; the adapter never commits or pushes.

```sh
bun test src/adapters/files
```
