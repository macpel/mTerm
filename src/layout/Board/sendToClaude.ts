//! "Send to Claude" from a board card: the card becomes a Claude session's instruction, and that session
//! takes the card once the instruction has actually been delivered.
//!
//! A new session goes through mTerm's New Agent Session dialog (worktree, permission mode and so on), prefilled
//! from the card and starting in plan mode; the card reaches it as its first message.
//! Delivery follows the Git panel's handoff (agentHandoff.ts): a conversation-view session gets an ordinary
//! message through the composer outbox, which starts a stopped agent first; a terminal session gets a
//! bracketed paste and Enter; a new terminal session gets the card as its first launch prompt.
import { boardClaim, type BoardCard } from "../../ipc/board";
import { chatStart } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { useTermStore } from "../../store/termStore";
import type { Session } from "../../types";
import { createSubmission, deliverSubmission } from "../CenterPane/session/outbox";

export function cardPrompt(card: BoardCard): string {
  const parts = [`Board card #${card.number} (${card.type}, ${card.priority}): ${card.title}`];
  if (card.description.trim()) parts.push(card.description.trim());
  parts.push(`When the work is finished, run vboard done ${card.number}.`);
  return parts.join("\n\n");
}

/** Worktree (directory and branch) name from the card title, e.g. "Fix login crash!" → "fix-login-crash". */
export function worktreeName(card: BoardCard): string {
  const slug = card.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || `card-${card.number}`;
}

/** Starting values for the New Agent Session dialog opened from a card. */
export function cardSessionPrefill(card: BoardCard) {
  return { name: `#${card.number} ${card.title}`.slice(0, 60), worktreeName: worktreeName(card), permissionMode: "plan" };
}

async function sendToChat(id: string, prompt: string) {
  const item = createSubmission(id, prompt, [], "queue");
  // The outbox records a failure on the message itself and returns no receipt.
  const receipt = await deliverSubmission(id, item, () => chatStart(id));
  if (!receipt) throw new Error("The card could not be delivered to that session.");
}

async function sendToTerminal(id: string, prompt: string) {
  // Bracketed paste keeps the multi-line card as one input; control characters from the card are dropped.
  await ptyWrite(id, `\x1b[200~${prompt.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}\x1b[201~`);
  await ptyWrite(id, "\r");
}

/** The project's Claude sessions that can take a card now: any conversation view (a stopped agent is started
 * on delivery) and terminal views whose process is running. */
export function sendTargets(sessions: Session[], runtimes: Record<string, { status?: string } | undefined>, projectId: string): Session[] {
  return sessions.filter(
    (s) =>
      s.projectId === projectId &&
      s.kind === "claude" &&
      !s.archivedAt &&
      (s.engine === "chat" || runtimes[s.id]?.status === "running"),
  );
}

/** Hand `card` to a session the dialog just created, before it opens. */
export async function startCardSession(projectId: string, card: BoardCard, session: Session): Promise<void> {
  const store = useTermStore.getState();
  const prompt = cardPrompt(card);
  if (session.engine === "chat") {
    store.openSession(session.id);
    await sendToChat(session.id, prompt);
  } else {
    // The terminal view takes its first message as a launch argument when the session first starts.
    store.setPendingPrompt(session.id, prompt);
  }
  await boardClaim(projectId, card.number, session.id);
}

/** Hand `card` to an existing session. */
export async function sendCardToSession(projectId: string, card: BoardCard, session: Session): Promise<void> {
  useTermStore.getState().openSession(session.id);
  const prompt = cardPrompt(card);
  if (session.engine === "chat") await sendToChat(session.id, prompt);
  else await sendToTerminal(session.id, prompt);
  await boardClaim(projectId, card.number, session.id);
}
