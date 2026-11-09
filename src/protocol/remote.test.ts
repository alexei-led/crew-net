import { expect, test } from "bun:test";
import { parseRepoIdentity } from "./remote";

test.each([
  [
    "https://github.com/alexei-led/crew-net.git",
    "github.com",
    "alexei-led/crew-net",
  ],
  [
    "https://github.com/alexei-led/crew-net",
    "github.com",
    "alexei-led/crew-net",
  ],
  [
    "git@github.com:alexei-led/crew-net.git",
    "github.com",
    "alexei-led/crew-net",
  ],
  [
    "ssh://git@github.example:2222/owner/repo.git",
    "github.example",
    "owner/repo",
  ],
  ["https://GitHub.Example/Owner/my.repo/", "github.example", "Owner/my.repo"],
  ["git@acme.ghe.com:acme/app.git", "acme.ghe.com", "acme/app"],
  ["ssh://git@ssh.github.com:443/owner/repo.git", "github.com", "owner/repo"],
])("repo identity: %s", (remote, host, repo) => {
  expect(parseRepoIdentity(remote)).toEqual({ host, repo });
});

test.each([
  "/tmp/local.git",
  "file:///tmp/repo",
  "https://github.com/owner",
  "git@host:owner/repo/extra",
  "https://host/a/b/c",
  "git@:owner/repo",
  "git@bad_host:owner/repo",
])("rejects unsupported origin %s", (remote) => {
  expect(() => parseRepoIdentity(remote)).toThrow();
});
