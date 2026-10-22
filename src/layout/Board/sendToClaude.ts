//! "Send to Claude" from a board card: the card becomes a Claude session's instruction, and that session
//! takes the card. A new session gets it as its first message; an existing one receives it like typed input.
import { boardClaim, type BoardCard } from "../../ipc/board";
import { chatSend } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { defaultEngineFor } from "../../store/settings";
import { useTermStore } from "../../store/termStore";
import type { Session } from "../../types";

export function cardPrompt(card: BoardCard): string {
  const parts = [`Work on board card #${card.number} (${card.type}, ${card.priority}): ${card.title}`];
  if (card.description.trim()) parts.push(card.description.trim());
  parts.push(`Use vboard to add notes as you go, and run vboard done ${card.number} "what changed" when finished.`);
  return parts.join("\n\n");
}

/** Hand `card` to a new Claude session in the project, or to an existing session. */
export async function sendCardToClaude(projectId: string, card: BoardCard, target: "new" | Session): Promise<void> {
  const store = useTermStore.getState();
  const prompt = cardPrompt(card);
  if (target === "new") {
    const engine = defaultEngineFor("claude", store.agentDefaults);
    const name = `#${card.number} ${card.title}`.slice(0, 60);
    const session = await store.addSession({ projectId, groupId: null, kind: "claude", name, engine });
    if (!session) return;
    await boardClaim(projectId, card.number, session.id);
    if ((session.engine ?? engine) === "chat") {
      store.openSession(session.id);
      await chatSend(session.id, prompt, "queue");
    } else {
      // The terminal view takes its first message as a launch argument when the session first starts.
      store.setPendingPrompt(session.id, prompt);
      store.openSession(session.id);
    }
    return;
  }
  await boardClaim(projectId, card.number, target.id);
  if (target.engine === "chat") await chatSend(target.id, prompt, "queue");
  else await ptyWrite(target.id, prompt + "\r");
  store.openSession(target.id);
}
