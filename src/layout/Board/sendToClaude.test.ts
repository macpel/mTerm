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
  receipt: "sent" as string | undefined,
}));

vi.mock("../../store/termStore", () => ({ useTermStore: { getState: () => h.store } }));
vi.mock("../../ipc/board", () => ({
  boardClaim: vi.fn((..._args: unknown[]) => {
    h.calls.push("claim");
    return Promise.resolve({});
  }),
}));
vi.mock("../../ipc/chat", () => ({ chatStart: vi.fn(() => Promise.resolve()) }));
vi.mock("../CenterPane/session/outbox", () => ({
  createSubmission: vi.fn((_session: string, text: string) => ({ id: "msg-1", text })),
  // Like the real outbox: failures are recorded on the message and no receipt comes back.
  deliverSubmission: vi.fn(async (_session: string, _item: unknown, start?: () => Promise<void>) => {
    await start?.();
    h.calls.push("deliver");
    return h.receipt;
  }),
}));
vi.mock("../../ipc/commands", () => ({
  ptyWrite: vi.fn((..._args: unknown[]) => {
    h.calls.push("ptyWrite");
    return Promise.resolve();
  }),
}));

import { boardClaim } from "../../ipc/board";
import { chatStart } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { createSubmission } from "../CenterPane/session/outbox";
import { cardPrompt, sendCardToClaude, sendTargets } from "./sendToClaude";

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
  h.receipt = "sent";
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
    expect(h.store.setPendingPrompt).toHaveBeenCalledWith("s9", cardPrompt(card));
    expect(h.store.openSession).toHaveBeenCalledWith("s9");
    expect(boardClaim).toHaveBeenCalledWith("p1", 7, "s9");
  });

  it("new chat session starts its agent through the outbox, then takes the card", async () => {
    h.store.addSession.mockResolvedValue(session("s10", "chat"));
    await sendCardToClaude("p1", card, "new");
    expect(h.store.openSession).toHaveBeenCalledWith("s10");
    expect(createSubmission).toHaveBeenCalledWith("s10", cardPrompt(card), [], "queue");
    expect(chatStart).toHaveBeenCalledWith("s10");
    expect(h.calls).toEqual(["deliver", "claim"]);
  });

  it("does not take the card when the chat message is not delivered", async () => {
    h.receipt = undefined;
    await expect(sendCardToClaude("p1", card, session("s2", "chat"))).rejects.toThrow();
    expect(boardClaim).not.toHaveBeenCalled();
  });

  it("terminal session gets a bracketed paste without control characters, then Enter, then the card", async () => {
    await sendCardToClaude("p1", { ...card, description: "Line one\nLine two\x1b[31m\x07" }, session("s1", "tui"));
    const pasted = vi.mocked(ptyWrite).mock.calls[0][1];
    expect(pasted.startsWith("\x1b[200~")).toBe(true);
    expect(pasted.endsWith("\x1b[201~")).toBe(true);
    expect(pasted).toContain("Line one\nLine two[31m");
    expect(pasted.slice(6, -6)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(vi.mocked(ptyWrite).mock.calls[1]).toEqual(["s1", "\r"]);
    expect(h.calls).toEqual(["ptyWrite", "ptyWrite", "claim"]);
    expect(h.store.openSession).toHaveBeenCalledWith("s1");
  });

  it("does not take the card when writing to the terminal fails", async () => {
    vi.mocked(ptyWrite).mockRejectedValueOnce(new Error("no running process"));
    await expect(sendCardToClaude("p1", card, session("s1", "tui"))).rejects.toThrow();
    expect(boardClaim).not.toHaveBeenCalled();
  });

  it("offers chat sessions and only running terminal sessions of the project", () => {
    const sessions = [
      session("chat", "chat"),
      session("tui-running", "tui"),
      session("tui-stopped", "tui"),
      { ...session("other-project", "chat"), projectId: "p2" },
      { ...session("archived", "chat"), archivedAt: 1 },
      { ...session("shell", "tui"), kind: "terminal" } as Session,
    ];
    const runtimes = { "tui-running": { status: "running" }, "tui-stopped": { status: "exited" }, shell: { status: "running" } };
    expect(sendTargets(sessions, runtimes, "p1").map((s) => s.id)).toEqual(["chat", "tui-running"]);
  });
});
