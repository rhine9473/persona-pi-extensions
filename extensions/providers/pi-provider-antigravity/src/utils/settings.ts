import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AntigravitySettings,
  GlyphMode,
  RotationStrategy,
  SwitchNoticeMode,
} from "../types/types.js";
import { isRecord } from "./util.js";

const SETTINGS_FILE = "antigravity-settings.json";

export const DEFAULT_ANTIGRAVITY_SETTINGS: AntigravitySettings = {
  strategy: "sticky",
  switchNotice: "notify",
  maskEmails: true,
  glyphs: "auto",
  lastTab: "accounts",
};

function settingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, SETTINGS_FILE);
}

function asStrategy(value: unknown): RotationStrategy {
  return value === "sticky" || value === "round-robin" || value === "max-quota"
    ? value
    : DEFAULT_ANTIGRAVITY_SETTINGS.strategy;
}

function asSwitchNotice(value: unknown): SwitchNoticeMode {
  return value === "notify" || value === "silent"
    ? value
    : DEFAULT_ANTIGRAVITY_SETTINGS.switchNotice;
}

function asGlyphs(value: unknown): GlyphMode {
  return value === "auto" || value === "unicode" || value === "ascii"
    ? value
    : DEFAULT_ANTIGRAVITY_SETTINGS.glyphs;
}

function asTab(value: unknown): AntigravitySettings["lastTab"] {
  return value === "accounts" || value === "models" || value === "diagnostics"
    ? value
    : DEFAULT_ANTIGRAVITY_SETTINGS.lastTab;
}

export function loadAntigravitySettings(): AntigravitySettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULT_ANTIGRAVITY_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { ...DEFAULT_ANTIGRAVITY_SETTINGS };
    return {
      strategy: asStrategy(parsed.strategy),
      switchNotice: asSwitchNotice(parsed.switchNotice),
      maskEmails:
        typeof parsed.maskEmails === "boolean"
          ? parsed.maskEmails
          : DEFAULT_ANTIGRAVITY_SETTINGS.maskEmails,
      glyphs: asGlyphs(parsed.glyphs),
      lastTab: asTab(parsed.lastTab),
    };
  } catch {
    return { ...DEFAULT_ANTIGRAVITY_SETTINGS };
  }
}

export function saveAntigravitySettings(partial: Partial<AntigravitySettings>): AntigravitySettings {
  const current = loadAntigravitySettings();
  const next: AntigravitySettings = {
    strategy: partial.strategy !== undefined ? asStrategy(partial.strategy) : current.strategy,
    switchNotice:
      partial.switchNotice !== undefined ? asSwitchNotice(partial.switchNotice) : current.switchNotice,
    maskEmails:
      typeof partial.maskEmails === "boolean" ? partial.maskEmails : current.maskEmails,
    glyphs: partial.glyphs !== undefined ? asGlyphs(partial.glyphs) : current.glyphs,
    lastTab: partial.lastTab !== undefined ? asTab(partial.lastTab) : current.lastTab,
  };
  const path = settingsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Ignore read-only settings dir failures.
  }
  return next;
}
