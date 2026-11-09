import { isRecord } from "./repo";

/** `~/.config/crew-net/config.json`, the developer's own settings (design §14). */
export interface Settings {
  /** `reply`: an idle session wakes to answer a direct request. `off`: never. */
  autoWake: "reply" | "off";
  /** Overrides the repo's `agents-merge` default. */
  agentsMerge: boolean | undefined;
  /** Minutes without typing or a prompt before a session counts as idle. */
  idleMinutes: number;
  /** Extra watched repos, `owner/repo` on the host of the current repo. */
  watch: string[];
  /** Repos sync ignores entirely, `owner/repo`. */
  mute: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoWake: "reply",
  agentsMerge: undefined,
  idleMinutes: 10,
  watch: [],
  mute: [],
};

export interface ParsedSettings {
  settings: Settings;
  /** What `doctor` shows; an unreadable value falls back to its default. */
  problems: string[];
}

const slugs = (value: unknown, name: string, problems: string[]): string[] => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === "string" && /^[^/\s]+\/[^/\s]+$/.test(v))
  ) {
    problems.push(`${name}: expected a list of owner/repo`);
    return [];
  }
  return value.map((v) => v.toLowerCase());
};

/** Read the config file text. Unknown keys are ignored; bad values keep the default. */
export function parseSettings(text: string | undefined): ParsedSettings {
  const problems: string[] = [];
  if (text === undefined) return { settings: DEFAULT_SETTINGS, problems };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      settings: DEFAULT_SETTINGS,
      problems: ["config.json is not valid JSON"],
    };
  }
  if (!isRecord(raw)) {
    return {
      settings: DEFAULT_SETTINGS,
      problems: ["config.json must hold an object"],
    };
  }
  let autoWake = DEFAULT_SETTINGS.autoWake;
  if (raw.autoWake === "reply" || raw.autoWake === "off") {
    autoWake = raw.autoWake;
  } else if (raw.autoWake !== undefined) {
    problems.push('autoWake: expected "reply" or "off"');
  }
  let agentsMerge = DEFAULT_SETTINGS.agentsMerge;
  if (typeof raw.agentsMerge === "boolean") {
    agentsMerge = raw.agentsMerge;
  } else if (raw.agentsMerge !== undefined) {
    problems.push("agentsMerge: expected true or false");
  }
  let idleMinutes = DEFAULT_SETTINGS.idleMinutes;
  if (
    typeof raw.idleMinutes === "number" &&
    Number.isFinite(raw.idleMinutes) &&
    raw.idleMinutes > 0
  ) {
    idleMinutes = raw.idleMinutes;
  } else if (raw.idleMinutes !== undefined) {
    problems.push("idleMinutes: expected a positive number");
  }
  return {
    settings: {
      autoWake,
      agentsMerge,
      idleMinutes,
      watch: slugs(raw.watch, "watch", problems),
      mute: slugs(raw.mute, "mute", problems),
    },
    problems,
  };
}
