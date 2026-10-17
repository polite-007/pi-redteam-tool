/**
 * Shared FOFA credential/config loading for the FOFA extensions.
 *
 * Source: settings.json only — `redteam.fofa.{key,baseUrl}`. The file
 * itself is located by `_shared/settings.ts`, which also documents why the
 * `REDTEAM_FOFA_KEY` / `REDTEAM_FOFA_BASE_URL`
 * environment variables are no longer consulted: the account a tool spends
 * F-points on should not depend on which shell happened to launch the agent.
 *
 * This used to be copy-pasted verbatim into both fofa_search and fofa_host.
 * Keeping it in one place means a change to the loading rules cannot be
 * applied to one tool and forgotten in another.
 */
import {
  getSettingString,
  readSettings,
  resolveSettingsPath,
} from "./settings.ts";

export { resolveSettingsPath };

export const DEFAULT_BASE = "https://fofa.info";

export interface FofaConfig {
  key: string;
  baseUrl: string;
}

/**
 * The error every FOFA tool returns when no API key is configured.
 *
 * Names the config file explicitly: with `PI_SETTINGS_PATH` in play, telling
 * the user to edit "settings.json" is ambiguous.
 */
export function fofaNotConfiguredError(): {
  error: string;
  message: string;
  helpUrl: string;
} {
  return {
    error: "FOFA_NOT_CONFIGURED",
    message: `未配置 FOFA API Key。请在 ${resolveSettingsPath()} 中配置 redteam.fofa.key。`,
    helpUrl: "https://fofa.info/userInfo",
  };
}

/**
 * Load FOFA config from settings.json.
 *
 * Returns `null` when there is no usable key — whether the file is missing,
 * unreadable, malformed, or simply lacks `redteam.fofa.key`. Those cases are
 * not distinguishable to the caller, and all mean the same thing: not
 * configured.
 */
export function loadFofaConfig(): FofaConfig | null {
  const settings = readSettings();
  const key = getSettingString(settings, "redteam.fofa.key");
  if (!key) return null;

  return {
    key,
    baseUrl: getSettingString(settings, "redteam.fofa.baseUrl") ?? DEFAULT_BASE,
  };
}
