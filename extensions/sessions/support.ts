import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;

export type ScreenHint = readonly [keys: string, label: string];

/** Render a single hint line at the bottom of the screen */
export function hintLine(
  theme: Theme,
  hints: readonly (ScreenHint | undefined)[],
  width: number,
  notice?: string,
) {
  if (notice) {
    return truncateToWidth(theme.fg("accent", ` ${notice}`), width, "…");
  }
  const parts = hints
    .filter((hint): hint is ScreenHint => Boolean(hint))
    .map(([keys, label]) => {
      if (!keys) return theme.fg("dim", label);
      if (!label) return theme.fg("muted", keys);
      return `${theme.fg("muted", keys)} ${theme.fg("dim", label)}`;
    });
  return truncateToWidth(
    ` ${parts.join(theme.fg("dim", " · "))}`,
    width,
    theme.fg("dim", "…"),
  );
}

const UNSAFE_FORMAT_CHARACTER = /\p{Cf}/u;

type SanitizerState =
  | "text"
  | "escape"
  | "escape_intermediate"
  | "csi"
  | "osc"
  | "st_string";

export class TerminalTextSanitizer {
  private state: SanitizerState = "text";
  private stringEscape = false;

  push(text: string) {
    let safe = "";
    for (const character of text) {
      const code = character.codePointAt(0)!;

      if (this.state === "osc" || this.state === "st_string") {
        if (character === "\u009c") {
          this.state = "text";
          this.stringEscape = false;
        } else if (this.state === "osc" && character === "\u0007") {
          this.state = "text";
          this.stringEscape = false;
        } else if (this.stringEscape && character === "\\") {
          this.state = "text";
          this.stringEscape = false;
        } else {
          this.stringEscape = character === "\u001b";
        }
        continue;
      }

      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        continue;
      }

      if (this.state === "escape" || this.state === "escape_intermediate") {
        if (this.state === "escape") {
          if (character === "[") {
            this.state = "csi";
            continue;
          }
          if (character === "]") {
            this.state = "osc";
            continue;
          }
          if (
            character === "P" ||
            character === "X" ||
            character === "^" ||
            character === "_"
          ) {
            this.state = "st_string";
            continue;
          }
        }
        if (code >= 0x20 && code <= 0x2f) {
          this.state = "escape_intermediate";
        } else if (code >= 0x30 && code <= 0x7e) {
          this.state = "text";
        } else {
          this.state = "text";
          safe += this.safeCharacter(character, code);
        }
        continue;
      }

      if (character === "\u001b") {
        this.state = "escape";
      } else if (character === "\u009b") {
        this.state = "csi";
      } else if (character === "\u009d") {
        this.state = "osc";
      } else if (
        character === "\u0090" ||
        character === "\u0098" ||
        character === "\u009e" ||
        character === "\u009f"
      ) {
        this.state = "st_string";
      } else {
        safe += this.safeCharacter(character, code);
      }
    }
    return safe;
  }

  private safeCharacter(character: string, code: number) {
    if (character === "\t") return "  ";
    if (
      character === "\n" ||
      character === "\u200c" ||
      character === "\u200d"
    ) {
      return character;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return "";
    return UNSAFE_FORMAT_CHARACTER.test(character) ? "" : character;
  }
}

export function sanitizeTerminalText(text: string) {
  return new TerminalTextSanitizer().push(text);
}

/** Check if a session belongs to a child subagent */
export function isSubagentSession(session: { name?: string }): boolean {
  if (!session.name) return false;
  return (
    session.name.startsWith("subagent[") ||
    session.name.startsWith("subagent:") ||
    session.name.startsWith("agent[") ||
    session.name.startsWith("agent:")
  );
}
