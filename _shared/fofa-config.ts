/**
 * Shared FOFA credential/config loading for the FOFA extensions.
 *
 * Priority: REDTEAM_FOFA_* environment variables > settings.json
 * (`redteam.fofa.*`), read from `PI_SETTINGS_PATH` or `~/.pi/agent/settings.json`.
 *
 * This used to be copy-pasted verbatim into both fofa_search and fofa_host.
 * Keeping it in one place means a change to the priority rules cannot be
 * applied to one tool and forgotten in another.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE = "https://fofa.info";

export interface FofaConfig {
  key: string;
  email?: string;
  baseUrl: string;
}

/**
 * The error every FOFA tool returns when no API key is configured.
 *
 * Shared rather than copied: this text is user-facing and was previously
 * duplicated per tool, where it had already drifted (fofa_host pointed users
 * at a stale `config/config.yaml` path that nothing else uses).
 */
export function fofaNotConfiguredError(): {
  error: string;
  message: string;
  helpUrl: string;
} {
  return {
    error: "FOFA_NOT_CONFIGURED",
    message:
      "未配置 FOFA API Key。请设置环境变量 REDTEAM_FOFA_KEY，或在 settings.json 中配置 redteam.fofa.key。",
    helpUrl: "https://fofa.info/userInfo",
  };
}

/**
 * Load FOFA config from environment variables or settings.json.
 * Priority: REDTEAM_FOFA_* env vars > settings.json redteam.fofa.*
 *
 * Returns `null` when no key is available from either source. Unreadable or
 * malformed settings.json is swallowed deliberately — a broken config file
 * should degrade to "not configured", not crash the tool.
 */
export function loadFofaConfig(): FofaConfig | null {
  const envKey = process.env.REDTEAM_FOFA_KEY?.trim();
  if (envKey) {
    return {
      key: envKey,
      email: process.env.REDTEAM_FOFA_EMAIL?.trim() || undefined,
      baseUrl: process.env.REDTEAM_FOFA_BASE_URL?.trim() || DEFAULT_BASE,
    };
  }

  const settingsPath =
    process.env.PI_SETTINGS_PATH || join(homedir(), ".pi", "agent", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, "utf8");
      const settings = JSON.parse(content);
      const fofa = settings?.redteam?.fofa;
      if (fofa?.key?.trim()) {
        return {
          key: fofa.key.trim(),
          email: fofa.email?.trim() || undefined,
          baseUrl: fofa.baseUrl?.trim() || DEFAULT_BASE,
        };
      }
    }
  } catch {
    // Ignore errors reading settings.json
  }

  return null;
}
