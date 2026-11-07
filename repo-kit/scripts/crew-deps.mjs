import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Keep this dependency-free reader in sync with src/protocol/state-block.ts.
export function parseStateBlock(body) {
  const match = /<!--[ \t]*crew-net[ \t]+v(\d+)(?:\.\d+)*\b([\s\S]*?)-->/.exec(
    body,
  );
  if (!match) return null;
  const version = Number(match[1]);
  if (version > 1) return { ok: false, reason: "unsupported-version", version };
  if (version < 1)
    return { ok: false, reason: "malformed", detail: `version ${version}` };
  const fields = new Map();
  for (const line of match[2].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key && !fields.has(key)) fields.set(key, line.slice(colon + 1).trim());
  }
  const lead = fields.get("lead");
  if (!lead) return { ok: false, reason: "malformed", detail: "missing lead" };
  const state = fields.get("state");
  if (!["planning", "building", "review", "blocked"].includes(state))
    return {
      ok: false,
      reason: "malformed",
      detail: "missing or unknown state",
    };
  const list = (value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const dependsOn = list(fields.get("depends-on"));
  const badRef = dependsOn.find(
    (ref) => !/^(?:[\w.-]+\/[\w.-]+)?#\d+$/.test(ref),
  );
  if (badRef !== undefined)
    return {
      ok: false,
      reason: "malformed",
      detail: `bad depends-on ref ${badRef}`,
    };
  return {
    ok: true,
    state: { lead, state, scope: list(fields.get("scope")), dependsOn },
  };
}

function sameRepo(ref, repo) {
  const [prefix, number] = ref.split("#");
  return !prefix || prefix.toLowerCase() === repo.toLowerCase() ? number : null;
}

function api(path, ...args) {
  return JSON.parse(
    execFileSync("gh", ["api", path, ...args], { encoding: "utf8" }),
  );
}

function check(file, repo, prNumber) {
  const body = readFileSync(file, "utf8");
  if (!/^\d+$/.test(prNumber ?? ""))
    throw new Error("GITHUB_PR_NUMBER is required");
  const current = api(`repos/${repo}/pulls/${prNumber}`);
  if ((current.body ?? "") !== body)
    throw new Error("PR body changed since this event; rerun the latest check");
  const result = parseStateBlock(body);
  if (!result) {
    if (/<!--[ \t]*crew-net\b/i.test(body))
      throw new Error("Malformed or incomplete crew-net state block");
    return console.log("No crew-net state block; no dependencies.");
  }
  if (!result.ok)
    throw new Error(`Invalid crew-net state block: ${JSON.stringify(result)}`);
  let blocked = false;
  for (const ref of result.state.dependsOn) {
    const number = sameRepo(ref, repo);
    if (number === null) {
      console.log(`Cross-repo dependency ${ref} is not enforced.`);
      continue;
    }
    const pull = api(`repos/${repo}/pulls/${number}`);
    if (!pull.merged_at) {
      console.error(`Dependency ${ref} is not merged.`);
      blocked = true;
    } else console.log(`Dependency ${ref} is merged.`);
  }
  if (blocked) process.exitCode = 1;
}

function rerun(repo, mergedNumber) {
  // Each page is a separate JSON array; --slurp collects them before parsing.
  const pages = api(
    `repos/${repo}/pulls?state=open&per_page=100`,
    "--paginate",
    "--slurp",
  );
  let failed = false;
  for (const pr of pages.flat()) {
    const result = parseStateBlock(pr.body ?? "");
    if (!result?.ok) {
      if (result)
        console.error(
          `PR #${pr.number}: invalid state block; its check remains failed.`,
        );
      continue;
    }
    if (
      !result.state.dependsOn.some((ref) => {
        const number = sameRepo(ref, repo);
        return number !== null && BigInt(number) === BigInt(mergedNumber);
      })
    )
      continue;
    try {
      const runs = api(
        `repos/${repo}/actions/workflows/crew-deps.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`,
      );
      const run = runs.workflow_runs.find(
        (item) =>
          item.head_branch === pr.head.ref &&
          item.pull_requests.some((pull) => pull.number === pr.number),
      );
      if (!run) throw new Error("no matching crew-deps run for current head");
      execFileSync(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${repo}/actions/runs/${run.id}/rerun`,
        ],
        { stdio: "inherit" },
      );
      console.log(`Reran crew-deps run ${run.id} for PR #${pr.number}.`);
    } catch (error) {
      console.error(`PR #${pr.number}: ${error.message}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [command, arg] = process.argv.slice(2);
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo || !arg)
      throw new Error(
        "Usage: crew-deps.mjs check BODY_FILE | rerun MERGED_PR_NUMBER (GITHUB_REPOSITORY required)",
      );
    if (command === "parse")
      console.log(JSON.stringify(parseStateBlock(readFileSync(arg, "utf8"))));
    else if (command === "check")
      check(arg, repo, process.env.GITHUB_PR_NUMBER);
    else if (command === "rerun" && /^\d+$/.test(arg)) rerun(repo, arg);
    else throw new Error("Unknown command or invalid PR number");
  } catch (error) {
    console.error(`crew-deps: ${error.message}`);
    process.exitCode = 1;
  }
}
