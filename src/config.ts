import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { UsageError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://smtpfa.st/api";
export const DEFAULT_PROFILE = "default";

export interface Profile {
  api_key?: string;
  base_url?: string;
}

export interface ConfigFile {
  current?: string;
  profiles: Record<string, Profile>;
}

export function configDir(env: Record<string, string | undefined>, platform: NodeJS.Platform, home: string): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "smtpfast");
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "smtpfast");
  return join(home, ".config", "smtpfast");
}

export function configPath(dir: string): string {
  return join(dir, "config.json");
}

export function readConfig(dir: string): ConfigFile {
  const file = configPath(dir);
  if (!existsSync(file)) return { profiles: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError(`${file} is not valid JSON`, "Fix or delete the file, then run smtpfast login again.", false);
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Partial<ConfigFile>;
  const profiles = obj.profiles && typeof obj.profiles === "object" ? obj.profiles : {};
  return { current: typeof obj.current === "string" ? obj.current : undefined, profiles };
}

/**
 * Write a file through a temp file that then replaces the target. The temp
 * file has a random name and is opened with "wx" (O_CREAT | O_EXCL), so a
 * file or symlink planted in the directory is never written through.
 */
export function writeFileAtomic(file: string, content: string, mode: number): void {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Write a file readable only by the owner. Refuses to replace a symlink, so the key never lands somewhere unexpected. */
export function writePrivateFile(file: string, content: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    // The file does not exist yet.
  }
  if (isLink) {
    throw new UsageError(`${file} is a symbolic link`, "smtpfast does not write an API key through a link. Replace the link with a regular file, then try again.", false);
  }
  writeFileAtomic(file, content, 0o600);
}

/** Create the config directory with mode 700. A directory that already exists keeps its mode. */
export function ensureDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function writeConfig(dir: string, config: ConfigFile): void {
  ensureDir(dir);
  const ordered: ConfigFile = { current: config.current, profiles: config.profiles };
  writePrivateFile(configPath(dir), `${JSON.stringify(ordered, null, 2)}\n`);
}

export function validateProfileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new UsageError(`Invalid profile name "${name}"`, "Use letters, digits, dot, dash and underscore.");
  }
  return name;
}

export type Source = "flag" | "env" | "profile" | "default";

export interface Settings {
  profile: string;
  profileSource: Exclude<Source, "profile"> | "config";
  apiKey?: string;
  apiKeySource?: Source;
  baseUrl: string;
  baseUrlSource: Source;
}

export interface GlobalAuthFlags {
  apiKey?: string;
  profile?: string;
  baseUrl?: string;
}

/**
 * Precedence, highest first:
 *   API key:  --api-key, SMTPFAST_API_KEY, the profile
 *   Base URL: --base-url, SMTPFAST_BASE_URL, the profile, the default
 *   Profile:  --profile, SMTPFAST_PROFILE, "current" in config.json, "default"
 */
export function resolveSettings(flags: GlobalAuthFlags, env: Record<string, string | undefined>, config: ConfigFile): Settings {
  let profile: string;
  let profileSource: Settings["profileSource"];
  if (flags.profile) {
    profile = validateProfileName(flags.profile);
    profileSource = "flag";
  } else if (env.SMTPFAST_PROFILE) {
    profile = validateProfileName(env.SMTPFAST_PROFILE);
    profileSource = "env";
  } else if (config.current) {
    profile = config.current;
    profileSource = "config";
  } else {
    profile = DEFAULT_PROFILE;
    profileSource = "default";
  }
  const stored = config.profiles[profile] ?? {};

  let apiKey: string | undefined;
  let apiKeySource: Source | undefined;
  if (flags.apiKey) {
    apiKey = flags.apiKey;
    apiKeySource = "flag";
  } else if (env.SMTPFAST_API_KEY) {
    apiKey = env.SMTPFAST_API_KEY;
    apiKeySource = "env";
  } else if (stored.api_key) {
    apiKey = stored.api_key;
    apiKeySource = "profile";
  }

  let baseUrl = DEFAULT_BASE_URL;
  let baseUrlSource: Source = "default";
  if (flags.baseUrl) {
    baseUrl = flags.baseUrl;
    baseUrlSource = "flag";
  } else if (env.SMTPFAST_BASE_URL) {
    baseUrl = env.SMTPFAST_BASE_URL;
    baseUrlSource = "env";
  } else if (stored.base_url) {
    baseUrl = stored.base_url;
    baseUrlSource = "profile";
  }
  return { profile, profileSource, apiKey, apiKeySource, baseUrl: baseUrl.replace(/\/+$/, ""), baseUrlSource };
}
