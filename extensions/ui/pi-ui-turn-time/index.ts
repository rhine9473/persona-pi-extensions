/**
 * Close each finished request with a clean hairline divider and elapsed time,
 * rendered under the final message. The entry is TUI-only: it is never sent to
 * the model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface TurnTimeData {
  ms: number;
}

/** Sub-second requests are noise, not information. */
const MIN_REPORTED_MS = 1_000;

export function formatTurnDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export default function (pi: ExtensionAPI) {
  // Measured from the first agent run to the settle that ends the request, so
  // retries, auto-compaction, and queued continuations are all included.
  let startedAt: number | undefined;

  pi.registerEntryRenderer<TurnTimeData>(
    "turn-time",
    (entry, _options, theme) => {
      const ms = entry.data?.ms;
      const duration = ms === undefined ? "?" : formatTurnDuration(ms);
      return {
        render(width: number) {
          const pad = " ";
          const innerWidth = Math.max(12, width - 2);
          const badge = ` ${theme.fg("success", "✓")} ${theme.fg("dim", `耗时 ${duration}`)} `;
          const lead = theme.fg("borderMuted", "──");
          const restCount = Math.max(0, innerWidth - 2 - visibleWidth(badge));
          const tail = restCount > 0 ? theme.fg("borderMuted", "─".repeat(restCount)) : "";
          return [truncateToWidth(`${pad}${lead}${badge}${tail}`, Math.max(1, width), "")];
        },
        invalidate() {},
      };
    },
  );

  pi.on("agent_start", () => {
    startedAt ??= Date.now();
  });

  pi.on("agent_settled", () => {
    if (startedAt === undefined) return;
    const ms = Date.now() - startedAt;
    startedAt = undefined;
    if (ms < MIN_REPORTED_MS) return;
    pi.appendEntry<TurnTimeData>("turn-time", { ms });
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
  });
}
