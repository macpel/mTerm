//! "Send to Claude" from a board card: the card becomes a Claude session's instruction, and that session
//! takes the card once the instruction has actually been delivered.
//!
//! Delivery follows the Git panel's handoff (agentHandoff.ts): a conversation-view session gets an ordinary
//! message through the composer outbox, which starts a stopped agent first; a terminal session gets a
//! bracketed paste and Enter; a new terminal session gets the card as its first launch prompt.
import { boardClaim, type BoardCard } from "../../ipc/board";
import { chatStart } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { defaultEngineFor } from "../../store/settings";
import { useTermStore } from "../../store/termStore";
import type { Session } from "../../types";
import { createSubmission, deliverSubmission } from "../CenterPane/session/outbox";

export function cardPrompt(card: BoardCard): string {
  const parts = [`Work on board card #${card.number} (${card.type}, ${card.priority}): ${card.title}`];
  if (card.description.trim()) parts.push(card.description.trim());
  parts.push(`Use vboard to add notes as you go, and run vboard done ${card.number} "what changed" when finished.`);
  return parts.join("\n\n");
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

/** Hand `card` to a new Claude session in the project, or to an existing session. */
export async function sendCardToClaude(projectId: string, card: BoardCard, target: "new" | Session): Promise<void> {
  const store = useTermStore.getState();
  const prompt = cardPrompt(card);
  let session: Session;
  if (target === "new") {
    const engine = defaultEngineFor("claude", store.agentDefaults);
    const name = `#${card.number} ${card.title}`.slice(0, 60);
    const created = await store.addSession({ projectId, groupId: null, kind: "claude", name, engine });
    if (!created) return;
    session = created;
    if ((session.engine ?? engine) === "tui") {
      // The terminal view takes its first message as a launch argument when the session first starts.
      store.setPendingPrompt(session.id, prompt);
      store.openSession(session.id);
    } else {
      store.openSession(session.id);
      await sendToChat(session.id, prompt);
    }
  } else {
    session = target;
    store.openSession(session.id);
    if (session.engine === "chat") await sendToChat(session.id, prompt);
    else await sendToTerminal(session.id, prompt);
  }
  await boardClaim(projectId, card.number, session.id);
}
