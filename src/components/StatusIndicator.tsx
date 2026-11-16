//! Vlinx-style session status indicator shared by the left project tree and center tabs for consistent icons.
//! Color semantics: ready (running) = blue; working = breathing green; awaiting action (asking) = breathing yellow;
//! replied (waiting) = magenta; replied with background work still running (background) = steady cyan, since it needs no user action; idle = no indicator.
//! Unread notifications take precedence as a rippling yellow dot and clear when the session opens.
//!
//! With `label`, a short word in the dot's color follows the dot (the left tree uses it), so the state reads
//! without remembering what each color means.

import { t } from "../i18n";
import type { DisplayStatus } from "../types";

interface Look {
  /** Dot classes; the label takes the same color through `.status-labelled.lbl-<state>`. */
  dot: string;
  state: string;
  title: string;
  short: string;
}

function look(status: DisplayStatus, unread: boolean | undefined): Look | null {
  // Unread takes precedence as a prominent rippling dot that clears when opened (see termStore.openSession).
  // Its label keeps a state that still asks something of the user, otherwise it says the reply is new.
  if (unread) {
    const short =
      status === "asking" ? t("status.short.asking") : status === "background" ? t("status.short.background") : t("status.short.unread");
    return { dot: "st-unread", state: "lbl-unread", title: t("indicator.unread"), short };
  }
  switch (status) {
    case "asking":
      return { dot: "st-attention vlx-status-pulse", state: "lbl-attention", title: t("status.asking"), short: t("status.short.asking") };
    case "waiting":
      return { dot: "st-waiting", state: "lbl-waiting", title: t("status.waiting"), short: t("status.short.waiting") };
    case "background":
      return { dot: "st-background", state: "lbl-background", title: t("status.background"), short: t("status.short.background") };
    case "error":
      return { dot: "st-error", state: "lbl-error", title: t("status.error"), short: t("status.short.error") };
    case "working":
      return { dot: "st-working vlx-status-pulse", state: "lbl-working", title: t("status.working"), short: t("status.short.working") };
    case "unavailable":
      return { dot: "st-unavailable", state: "lbl-unavailable", title: t("status.unavailable"), short: t("status.short.unavailable") };
    case "running":
      return { dot: "st-ready", state: "lbl-ready", title: t("status.running"), short: t("status.short.running") };
    default:
      return null;
  }
}

export function StatusIndicator({
  status,
  unread,
  label,
}: {
  status: DisplayStatus;
  unread?: boolean;
  /** Show a short word after the dot. */
  label?: boolean;
}) {
  const l = look(status, unread);
  if (!l) return null;
  if (!label) return <span className={`status-dot ${l.dot}`} title={l.title} />;
  return (
    <span className={`status-labelled ${l.state}`} title={l.title}>
      <span className={`status-dot ${l.dot}`} />
      <span className="status-label">{l.short}</span>
    </span>
  );
}
