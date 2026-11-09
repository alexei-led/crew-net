/** Flags one command accepts, on top of the global ones. */
export interface FlagSpec {
  /** Flags that take a value: `--name value` or `--name=value`. Repeatable. */
  values: readonly string[];
  /** Flags that take no value. */
  switches: readonly string[];
}

export interface Parsed {
  positional: string[];
  values: ReadonlyMap<string, readonly string[]>;
  switches: ReadonlySet<string>;
}

export class UsageError extends Error {}

/** Flags every command accepts (design: user guide). */
export const GLOBAL_FLAGS: FlagSpec = {
  values: ["--repo"],
  switches: ["--json", "--help"],
};

export function mergeFlags(...specs: FlagSpec[]): FlagSpec {
  return {
    values: specs.flatMap((spec) => [...spec.values]),
    switches: specs.flatMap((spec) => [...spec.switches]),
  };
}

/**
 * Parse one command's arguments. Unknown flags are a UsageError, so a typo
 * never runs a command with a silently ignored option. `--` ends flag parsing.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec): Parsed {
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  const positional: string[] = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (literal || !word.startsWith("--")) {
      positional.push(word);
      continue;
    }
    if (word === "--") {
      literal = true;
      continue;
    }
    const eq = word.indexOf("=");
    const name = eq === -1 ? word : word.slice(0, eq);
    if (spec.switches.includes(name)) {
      if (eq !== -1) throw new UsageError(`${name} takes no value`);
      switches.add(name);
      continue;
    }
    if (!spec.values.includes(name)) {
      throw new UsageError(`unknown flag ${name}`);
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = word.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${name} needs a value`);
      }
      value = next;
      i++;
    }
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { positional, values, switches };
}

/** The single value of a flag: undefined when absent, UsageError when repeated. */
export function single(parsed: Parsed, name: string): string | undefined {
  const found = parsed.values.get(name);
  if (found === undefined) return undefined;
  if (found.length > 1) throw new UsageError(`${name} given more than once`);
  return found[0];
}
