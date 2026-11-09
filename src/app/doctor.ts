import { parseRepoConfig } from "../protocol/index";
import { ssoPartialKey } from "./inbox";
import type { AppPorts } from "./ports";
import { REPO_CONFIG_PATH } from "./radar";
import { isRecord, repoSlug } from "./repo";
import type { Here } from "./scope";
import { SYNC_STATUS_KEY } from "./sync";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  checks: Check[];
  /** Adoption level reached (design: user guide), or null when level 0 is not. */
  level: number | null;
  next: string;
}

/** Machine facts the ports do not cover; the CLI reads them from disk. */
export interface DoctorProbes {
  plugin(): Promise<"installed" | "missing" | "unknown">;
  /** A file of the working copy, by path from its root. */
  readRepoFile(path: string): Promise<string | undefined>;
  /** Names in a directory of the working copy; empty when it is absent. */
  listRepoDir(path: string): Promise<string[]>;
}

export const INSTALL =
  "claude plugin marketplace add alexei-led/crew-net && claude plugin install crew-net@crew-net";
export const DRAFT_GATE = "github.event.pull_request.draft == false";
const PEER_EVENTS = new Set(["ask", "review", "fix", "bug", "info", "reply"]);

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * `crew-net doctor` (design: user guide, Failure and recovery): `gh` and token, SSO, the managed
 * hooks policy, the plugin and therefore the merge gate, the repo config
 * and CI files; the adoption level reached and the next step. A missing
 * gate is a failure, never a pass.
 */
export async function doctor(
  ports: AppPorts,
  probes: DoctorProbes,
  here: Here | undefined,
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
  const host = here?.ref.host ?? "github.com";

  let tokenOk = false;
  try {
    await ports.env.githubToken(host);
    tokenOk = true;
    add({
      name: "gh token",
      status: "ok",
      detail: `gh has a token for ${host}`,
    });
  } catch (error) {
    add({
      name: "gh token",
      status: "fail",
      detail: `gh has no token for ${host}: gh is not installed or not signed in (${message(error)})`,
      fix: `gh auth login --hostname ${host}`,
    });
  }
  let viewerOk = false;
  if (tokenOk) {
    try {
      const login = await ports.github(host).viewer();
      viewerOk = true;
      add({
        name: "GitHub access",
        status: "ok",
        detail: `signed in as ${login}`,
      });
    } catch (error) {
      add({
        name: "GitHub access",
        status: "fail",
        detail: message(error),
        fix: `gh auth refresh --hostname ${host}`,
      });
    }
  }
  const partial = await ports.store.kv.get(ssoPartialKey(host));
  if (Array.isArray(partial) && partial.length > 0) {
    add({
      name: "SSO",
      status: "warn",
      detail: `GitHub left out organizations without SSO authorization: ${partial.join(", ")}`,
      fix: `gh auth refresh --hostname ${host}`,
    });
  }

  const policy = await ports.env.managedHooksOnly();
  const hooksAllowed = policy.status === "known" && !policy.enabled;
  if (policy.status === "unknown") {
    add({
      name: "hooks policy",
      status: "warn",
      detail: `could not read the managed settings: ${policy.reason}`,
    });
  } else if (policy.enabled) {
    add({
      name: "hooks policy",
      status: "fail",
      detail:
        "allowManagedHooksOnly is set by MDM: plugin hooks and the mod do not run. No digest at start, no merge gate, no wake; the CLI still works by hand",
      fix: "ask IT to allow the crew-net plugin hooks",
    });
  } else {
    add({ name: "hooks policy", status: "ok", detail: "plugin hooks may run" });
  }

  const plugin = await probes.plugin();
  add(
    plugin === "installed"
      ? { name: "plugin", status: "ok", detail: "crew-net plugin installed" }
      : {
          name: "plugin",
          status: plugin === "missing" ? "fail" : "warn",
          detail:
            plugin === "missing"
              ? "crew-net plugin not installed in Claude Code"
              : "could not tell whether the Claude Code plugin is installed",
          fix: INSTALL,
        },
  );
  const gateActive = plugin === "installed" && hooksAllowed;
  add({
    name: "merge gate",
    status: gateActive ? "ok" : "fail",
    detail: gateActive
      ? "the PreToolUse hook checks depends-on before gh pr merge"
      : "inactive: agents can merge a PR whose dependencies are open",
    ...(gateActive
      ? {}
      : {
          fix: hooksAllowed
            ? INSTALL
            : "the plugin hooks must be allowed to run (see hooks policy above)",
        }),
  });

  let configOk = false;
  let draftGate = false;
  let depsCheck = false;
  if (!here) {
    add({
      name: "repo",
      status: "warn",
      detail: "not in a working copy with a GitHub origin; repo checks skipped",
    });
  } else {
    add({ name: "repo", status: "ok", detail: repoSlug(here.ref) });
    const text = await probes.readRepoFile(REPO_CONFIG_PATH);
    if (text === undefined) {
      add({
        name: "repo config",
        status: "warn",
        detail: `no ${REPO_CONFIG_PATH}: default contracts apply`,
        fix: "crew-net init",
      });
    } else {
      const parsed = parseRepoConfig(text);
      configOk = parsed.ok;
      add(
        parsed.ok
          ? {
              name: "repo config",
              status: "ok",
              detail: `${parsed.config.contracts.length} contract(s)`,
            }
          : {
              name: "repo config",
              status: "fail",
              detail: `${REPO_CONFIG_PATH}${parsed.line ? `:${parsed.line}` : ""}: ${parsed.detail}`,
            },
      );
    }
    const workflows = (await probes.listRepoDir(".github/workflows")).filter(
      (n) => /\.ya?ml$/.test(n),
    );
    depsCheck = workflows.includes("crew-deps.yml");
    for (const name of workflows) {
      const body = await probes.readRepoFile(`.github/workflows/${name}`);
      if (body?.includes(DRAFT_GATE)) draftGate = true;
    }
    add({
      name: "draft gate",
      status: draftGate ? "ok" : "warn",
      detail: draftGate
        ? "CI skips draft PRs: early drafts are cheap"
        : "no workflow skips drafts; open PRs when the work is ready",
    });
    add({
      name: "crew-deps check",
      status: depsCheck ? "ok" : "warn",
      detail: depsCheck
        ? "crew-deps workflow present; make it a required check to enforce order"
        : "no crew-deps workflow: order is enforced only on agents with the plugin",
    });
  }

  for (const problem of ports.settingsProblems) {
    add({ name: "config.json", status: "warn", detail: problem });
  }
  const status = await ports.store.kv.get(SYNC_STATUS_KEY);
  if (
    isRecord(status) &&
    Array.isArray(status.failed) &&
    status.failed.length
  ) {
    add({
      name: "sync",
      status: "warn",
      detail: `last sync had failures: ${status.failed
        .map((f) => (isRecord(f) ? `${f.job}: ${f.error}` : ""))
        .join("; ")}`,
    });
  }

  const peers = (await ports.store.inbox.list()).some(
    (e) => e.item.kind === "message" && PEER_EVENTS.has(e.item.event ?? ""),
  );
  const levels = [
    tokenOk && viewerOk && plugin === "installed" && hooksAllowed,
    peers,
    configOk && draftGate,
    depsCheck,
  ];
  let level: number | null = null;
  for (const [i, ok] of levels.entries()) {
    if (!ok) break;
    level = i;
  }
  const firstFix = checks.find((c) => c.status === "fail" && c.fix)?.fix;
  const next =
    level === null
      ? (firstFix ?? "fix the failing checks above")
      : level === 0
        ? `level 1: a teammate installs crew-net too: ${INSTALL}`
        : level === 1
          ? "level 2: run `crew-net init`, review and commit .github/crew-net.yml and the draft gate"
          : level === 2
            ? "level 3: make the crew-deps check from the repo kit a required check"
            : "nothing: every level is set up";
  return { checks, level, next };
}

export function renderDoctor(report: DoctorReport): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines = report.checks.map(
    (c) =>
      `${mark[c.status]} ${c.name}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ""}`,
  );
  lines.push(
    `Level: ${report.level === null ? "not set up" : report.level}`,
    `Next: ${report.next}`,
  );
  return `${lines.join("\n")}\n`;
}
