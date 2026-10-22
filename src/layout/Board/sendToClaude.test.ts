import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "../../ipc/board";
import type { Session } from "../../types";

const h = vi.hoisted(() => ({
  store: {
    agentDefaults: {} as Record<string, { engine?: string }>,
    addSession: vi.fn(),
    openSession: vi.fn(),
    setPendingPrompt: vi.fn(),
  },
  calls: [] as string[],
}));

vi.mock("../../store/termStore", () => ({ useTermStore: { getState: () => h.store } }));
vi.mock("../../ipc/board", () => ({
  boardClaim: vi.fn((..._args: unknown[]) => {
    h.calls.push("claim");
    return Promise.resolve({});
  }),
}));
vi.mock("../../ipc/chat", () => ({
  chatSend: vi.fn((..._args: unknown[]) => {
    h.calls.push("chatSend");
    return Promise.resolve("sent");
  }),
}));
vi.mock("../../ipc/commands", () => ({
  ptyWrite: vi.fn((..._args: unknown[]) => {
    h.calls.push("ptyWrite");
    return Promise.resolve();
  }),
}));

import { boardClaim } from "../../ipc/board";
import { chatSend } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { cardPrompt, sendCardToClaude } from "./sendToClaude";

const card: BoardCard = {
  id: "c7",
  number: 7,
  column: "todo",
  position: 1,
  type: "bug",
  title: "Login crash",
  description: "Crashes on an empty password.",
  priority: "high",
  tags: [],
  claimedBy: null,
  claimedByName: null,
  updatedAt: 0,
  updatedBy: { kind: "user", sessionId: null, name: null },
};

function session(id: string, engine: "chat" | "tui"): Session {
  return { id, projectId: "p1", name: id, kind: "claude", engine } as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.store.agentDefaults = {};
});

describe("sendCardToClaude", () => {
  it("cardPrompt includes number, type, priority and done hint", () => {
    const prompt = cardPrompt(card);
    expect(prompt.startsWith("Work on board card #7 (bug, high): Login crash")).toBe(true);
    expect(prompt).toContain("Crashes on an empty password.");
    expect(prompt).toContain('vboard done 7 "');
    expect(cardPrompt({ ...card, description: "" })).not.toContain("\n\n\n");
  });

  it("new TUI session gets the prompt as its first launch prompt", async () => {
    h.store.agentDefaults = { claude: { engine: "tui" } };
    h.store.addSession.mockResolvedValue(session("s9", "tui"));
    await sendCardToClaude("p1", card, "new");
    expect(h.store.addSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", kind: "claude", name: "#7 Login crash", engine: "tui" }),
    );
    expect(boardClaim).toHaveBeenCalledWith("p1", 7, "s9");
    expect(h.store.setPendingPrompt).toHaveBeenCalledWith("s9", cardPrompt(card));
    expect(h.store.openSession).toHaveBeenCalledWith("s9");
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("new chat session gets the prompt via chatSend queue", async () => {
    h.store.addSession.mockResolvedValue(session("s10", "chat"));
    await sendCardToClaude("p1", card, "new");
    expect(h.store.addSession).toHaveBeenCalledWith(expect.objectContaining({ engine: "chat" }));
    expect(h.store.openSession).toHaveBeenCalledWith("s10");
    expect(chatSend).toHaveBeenCalledWith("s10", cardPrompt(card), "queue");
    expect(h.store.setPendingPrompt).not.toHaveBeenCalled();
  });

  it("existing session is claimed before sending", async () => {
    await sendCardToClaude("p1", card, session("s1", "tui"));
    expect(h.calls).toEqual(["claim", "ptyWrite"]);
    expect(ptyWrite).toHaveBeenCalledWith("s1", cardPrompt(card) + "\r");
    expect(h.store.openSession).toHaveBeenCalledWith("s1");
    h.calls = [];
    await sendCardToClaude("p1", card, session("s2", "chat"));
    expect(h.calls).toEqual(["claim", "chatSend"]);
  });
});
