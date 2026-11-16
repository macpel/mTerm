//! "Send to Claude" from a board card: the card becomes a Claude session's instruction, and that session
//! takes the card once the instruction has actually been delivered.
//!
//! A new session goes through mTerm's New Agent Session dialog (worktree, permission mode and so on), prefilled
//! from the card and starting in plan mode; the card reaches it as its first message.
//! Delivery follows the Git panel's handoff (agentHandoff.ts): a conversation-view session gets an ordinary
//! message through the composer outbox, which starts a stopped agent first; a terminal session gets a
//! bracketed paste and Enter; a new terminal session gets the card as its first launch prompt.
//!
//! Images pasted into the description travel too: every session gets their file paths at the end of the card,
//! which Claude opens itself, and a conversation-view session also gets them attached to the message.
import { boardClaim, isBoardImage, type BoardCard } from "../../ipc/board";
import { chatStart, type ChatImage } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { loadFileBlob } from "../../ipc/info";
import { md } from "../../markdownEngine";
import { useTermStore } from "../../store/termStore";
import type { Session } from "../../types";
import { mimeFromPath } from "../CenterPane/doc/docImageIO";
import { attachImages } from "../CenterPane/session/attachments";
import { createSubmission, deliverSubmission } from "../CenterPane/session/outbox";

/** Paths of the images pasted into the card's description, in order, without repeats. */
export function cardImagePaths(card: BoardCard): string[] {
  const paths = new Set<string>();
  md.walkTokens(md.lexer(card.description), (token) => {
    if (token.type === "image" && isBoardImage(token.href)) paths.add(token.href);
  });
  return [...paths];
}

export function cardPrompt(card: BoardCard): string {
  const parts = [`Board card #${card.number} (${card.type}, ${card.priority}): ${card.title}`];
  if (card.description.trim()) parts.push(card.description.trim());
  const images = cardImagePaths(card);
  if (images.length) parts.push(["Attached images:", ...images].join("\n"));
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

/** The card's images as chat attachments. One that cannot be read is left out; its path is still in the prompt. */
async function cardImages(card: BoardCard): Promise<ChatImage[]> {
  const files: File[] = [];
  for (const path of cardImagePaths(card)) {
    const loaded = await loadFileBlob(path).catch(() => null);
    if (loaded) files.push(new File([loaded.blob], path.split("/").pop() ?? "image.png", { type: mimeFromPath(path) }));
  }
  const { attachments } = await attachImages([], files);
  return attachments.map(({ mimeType, data }) => ({ mimeType, data }));
}

async function sendToChat(id: string, card: BoardCard) {
  const item = createSubmission(id, cardPrompt(card), await cardImages(card), "queue");
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
  if (session.engine === "chat") {
    store.openSession(session.id);
    await sendToChat(session.id, card);
  } else {
    // The terminal view takes its first message as a launch argument when the session first starts.
    store.setPendingPrompt(session.id, cardPrompt(card));
  }
  await boardClaim(projectId, card.number, session.id);
}

/** Hand `card` to an existing session. */
export async function sendCardToSession(projectId: string, card: BoardCard, session: Session): Promise<void> {
  useTermStore.getState().openSession(session.id);
  if (session.engine === "chat") await sendToChat(session.id, card);
  else await sendToTerminal(session.id, cardPrompt(card));
  await boardClaim(projectId, card.number, session.id);
}
