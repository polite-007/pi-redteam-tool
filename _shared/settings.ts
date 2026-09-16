/**
 * Shared `settings.json` access for every extension in this package.
 *
 * All configuration lives in one file — `~/.pi/agent/settings.json` by default
 * — under the `redteam` key. Extensions read it through here rather than each
 * parsing the file themselves: the path resolution, the "missing or malformed
 * file means no configuration" rule, and the blank-string handling are the
 * same everywhere, and were previously copy-pasted per tool (where the copies
 * had already drifted — two of them pointed users at a `config/config.yaml`
 * that nothing reads).
 *
 * ## Why settings.json and not the environment
 *
 * Configuration used to be readable from `REDTEAM_*` variables, with the
 * environment winning over the file. That made "which key is actually in use?"
 * unanswerable without knowing which shell launched the agent, and could
 * silently disagree with what the user thought they had configured. One
 * source — the file — means one place to look.
 *
 * `PI_SETTINGS_PATH` is the single exception and is read from the environment
 * on purpose: it *locates* the config file, it does not carry configuration.
 * Without it there would be no way to point the tools at a file during tests.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Settings = Record<string, unknown>;

/**
 * The settings file every extension reads: `PI_SETTINGS_PATH` if set, else
 * `~/.pi/agent/settings.json`.
 */
export function resolveSettingsPath(): string {
  return (
    process.env.PI_SETTINGS_PATH || join(homedir(), ".pi", "agent", "settings.json")
  );
}

/**
 * Parse the settings file.
 *
 * Returns `null` when the file is missing, unreadable, or not valid JSON. All
 * three degrade the same way on purpose — "no configuration" — because none of
 * them are actionable to a tool and a broken file must not crash one.
 *
 * Not cached: a user who fixes their key mid-session should not have to
 * restart the agent for the next tool call to see it.
 */
export function readSettings(): Settings | null {
  const path = resolveSettingsPath();
  try {
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Arrays and primitives are valid JSON but are never a settings object.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Settings;
  } catch {
    return null;
  }
}

/**
 * Read a dotted path out of a parsed settings object, e.g.
 * `getSettingString(settings, "redteam.httpx.proxy")`.
 *
 * Returns `undefined` for anything that is not a non-blank string: a missing
 * key, a wrong type, or whitespace. Callers apply their own defaults, so they
 * never have to distinguish "absent" from "blank" — neither is configuration.
 */
export function getSettingString(
  settings: Settings | null,
  path: string
): string | undefined {
  let node: unknown = settings;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Settings)[segment];
  }
  if (typeof node !== "string") return undefined;
  return node.trim() || undefined;
}
