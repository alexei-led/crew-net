import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Keep this dependency-free reader in sync with src/protocol/state-block.ts.
const STATES = ["planning", "building", "review", "blocked"];
const KNOWN_FIELDS = new Set(["state", "scope", "depends-on", "lead"]);
const OPEN = /<!--\s*crew-net(?=\s|-->)/i;
const DEPENDS_ON_MENTION = /depends[-_ ]?on[ \t]*:/gi;
const LEGACY_TAG = /^v\d+(?:\.\d+)*(?=\s|$)/;
const REF = /^(?:[\w.-]+\/[\w.-]+)?#\d+$/;
const KEY = /^[a-z][a-z0-9-]*$/;

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function parseStateBlock(body) {
  const open = OPEN.exec(body);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  const end = body.indexOf("-->", innerStart);
  if (end < 0)
    return { ok: false, reason: "malformed", detail: "unterminated block" };
  const inner = body.slice(innerStart, end);
  if (inner.includes("<!--"))
    return {
      ok: false,
      reason: "malformed",
      detail: "comment inside the block",
    };
  if (OPEN.test(body.slice(end + 3)))
    return {
      ok: false,
      reason: "malformed",
      detail: "more than one state block",
    };
  const text = inner.trimStart().replace(LEGACY_TAG, "");
  const fields = new Map();
  let dependsOnLines = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key === "depends-on") dependsOnLines++;
    if (key && !fields.has(key)) fields.set(key, line.slice(colon + 1).trim());
  }
  const warnings = [];
  // `state: review depends-on: #2` on one line, a bullet, `depends_on:` or a
  // repeated key would otherwise read as "no dependency".
  if (
    (text.match(DEPENDS_ON_MENTION)?.length ?? 0) !== dependsOnLines ||
    dependsOnLines > 1
  )
    warnings.push({
      field: "depends-on",
      value: "",
      detail: "must be one `depends-on:` line of its own",
    });
  const rawState = fields.get("state");
  const state = STATES.find((s) => s === rawState);
  if (rawState !== undefined && state === undefined)
    warnings.push({ field: "state", value: rawState, detail: "unknown state" });
  const dependsOn = [];
  for (const ref of list(fields.get("depends-on"))) {
    if (REF.test(ref)) dependsOn.push(ref);
    else warnings.push({ field: "depends-on", value: ref, detail: "bad ref" });
  }
  const extra = [...fields]
    .filter(([key]) => KEY.test(key) && !KNOWN_FIELDS.has(key))
    .map(([key, value]) => ({ key, value }));
  return {
    ok: true,
    state: {
      ...(state === undefined ? {} : { state }),
      scope: list(fields.get("scope")),
      dependsOn,
      extra,
    },
    warnings,
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

// Prints one line per dependency and returns true when any blocks the merge.
// A depends-on value the reader had to drop blocks too: skipping it would read
// as "no dependency".
function evaluate(body, repo) {
  const result = parseStateBlock(body);
  if (!result) {
    console.log("No crew-net state block; no dependencies.");
    return false;
  }
  if (!result.ok)
    throw new Error(`Invalid crew-net state block: ${JSON.stringify(result)}`);
  let blocked = false;
  for (const warning of result.warnings) {
    console.error(
      `Unreadable ${warning.field} value "${warning.value}": ${warning.detail}.`,
    );
    if (warning.field === "depends-on") blocked = true;
  }
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
  return blocked;
}

function check(file, repo, prNumber) {
  const body = readFileSync(file, "utf8");
  if (!/^\d+$/.test(prNumber ?? ""))
    throw new Error("GITHUB_PR_NUMBER is required");
  const current = api(`repos/${repo}/pulls/${prNumber}`);
  if ((current.body ?? "") !== body)
    throw new Error("PR body changed since this event; rerun the latest check");
  if (evaluate(body, repo)) process.exitCode = 1;
}

// GitHub names the merge queue branch gh-readonly-queue/<base>/pr-<N>-<sha>.
// The name carries one PR number: the PR the group was built for.
export function queuePullNumbers(headRef) {
  const match =
    /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{7,40}$/.exec(
      headRef ?? "",
    );
  if (!match) throw new Error(`Unrecognised merge queue ref: ${headRef}`);
  return [match[1]];
}

function checkQueue(headRef, repo) {
  let blocked = false;
  for (const number of queuePullNumbers(headRef)) {
    console.log(`Merge queue entry for PR #${number}.`);
    const pull = api(`repos/${repo}/pulls/${number}`);
    if (evaluate(pull.body ?? "", repo)) blocked = true;
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
    if (result && !result.ok) {
      // Cannot tell whether it depends on the merged PR: fail the job so it is seen.
      console.error(
        `PR #${pr.number}: unreadable state block (${result.detail}); not rerun.`,
      );
      failed = true;
      continue;
    }
    if (!result) continue;
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
        "Usage: crew-deps.mjs check BODY_FILE | check-queue QUEUE_HEAD_REF | rerun MERGED_PR_NUMBER (GITHUB_REPOSITORY required)",
      );
    if (command === "parse")
      console.log(JSON.stringify(parseStateBlock(readFileSync(arg, "utf8"))));
    else if (command === "check")
      check(arg, repo, process.env.GITHUB_PR_NUMBER);
    else if (command === "check-queue") checkQueue(arg, repo);
    else if (command === "rerun" && /^\d+$/.test(arg)) rerun(repo, arg);
    else throw new Error("Unknown command or invalid PR number");
  } catch (error) {
    console.error(`crew-deps: ${error.message}`);
    process.exitCode = 1;
  }
}
