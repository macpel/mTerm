import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard } from "../../ipc/board";
import type { Session } from "../../types";

const h = vi.hoisted(() => ({
  store: {
    openSession: vi.fn(),
    setPendingPrompt: vi.fn(),
  },
  calls: [] as string[],
  receipt: "sent" as string | undefined,
}));

vi.mock("../../store/termStore", () => ({ useTermStore: { getState: () => h.store } }));
const SHOT = "1f2e3d4c-0000-4000-8000-000000000001.png";
const MISSING = "1f2e3d4c-0000-4000-8000-000000000002.png";

vi.mock("../../ipc/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/board")>()),
  boardClaim: vi.fn((..._args: unknown[]) => {
    h.calls.push("claim");
    return Promise.resolve({});
  }),
  boardImageRead: vi.fn((name: string) => (name.endsWith("2.png") ? Promise.reject(new Error("gone")) : Promise.resolve(btoa("png")))),
}));
vi.mock("../CenterPane/session/attachments", () => ({
  attachImages: vi.fn(async (_current: unknown[], files: File[]) => ({
    attachments: files.map((file) => ({ id: "a", name: file.name, bytes: 3, mimeType: file.type, data: file.name })),
    rejected: [],
  })),
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

import { boardClaim, boardImageRead } from "../../ipc/board";
import { chatStart } from "../../ipc/chat";
import { ptyWrite } from "../../ipc/commands";
import { createSubmission } from "../CenterPane/session/outbox";
import { cardImagePaths, cardPrompt, cardSessionPrefill, sendCardToSession, sendTargets, startCardSession, worktreeName } from "./sendToClaude";

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
  color: null,
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
});

describe("sendToClaude", () => {
  it("cardPrompt includes number, type, priority and done hint", () => {
    const prompt = cardPrompt(card);
    expect(prompt.startsWith("Board card #7 (bug, high): Login crash")).toBe(true);
    expect(prompt).toContain("Crashes on an empty password.");
    expect(prompt).toContain("vboard done 7.");
    expect(cardPrompt({ ...card, description: "" })).not.toContain("\n\n\n");
  });

  it("lists the pasted images at the end of the card, once each, ignoring other images", () => {
    const shot = `C:/Users/me/AppData/Roaming/io.vlinx.vlxterm/board-images/${SHOT}`;
    const unsafe = [
      `\\\\attacker\\share\\board-images\\${SHOT}`,
      `//attacker/share/board-images/${SHOT}`,
      `\\\\?\\C:\\data\\board-images\\${SHOT}`,
      `C:/data/board-images/../../Windows/board-images/${SHOT}`,
      "C:/data/board-images/not-a-uuid.png",
    ];
    const withImages = {
      ...card,
      description: `Broken layout:\n\n![image](<${shot}>)\n\n![logo](https://example.com/logo.png) again ![image](<${shot}>)${unsafe
        .map((href) => ` ![x](<${href}>)`)
        .join("")}`,
    };
    expect(cardImagePaths(withImages)).toEqual([shot]);
    const prompt = cardPrompt(withImages);
    expect(prompt).toContain(`Attached images:\n${shot}\n\nWhen the work is finished`);
    expect(cardPrompt(card)).not.toContain("Attached images:");
  });

  it("prefills the new-session dialog from the card, in plan mode", () => {
    expect(cardSessionPrefill({ ...card, title: "Fix: login crash (Windows)!" })).toEqual({
      name: "#7 Fix: login crash (Windows)!",
      worktreeName: "fix-login-crash-windows",
      permissionMode: "plan",
    });
    expect(worktreeName({ ...card, title: "日本語" })).toBe("card-7");
    expect(worktreeName({ ...card, title: "a".repeat(80) })).toHaveLength(40);
  });

  it("new terminal session gets the card as its first launch prompt, then takes it", async () => {
    await startCardSession("p1", card, session("s9", "tui"));
    expect(h.store.setPendingPrompt).toHaveBeenCalledWith("s9", cardPrompt(card));
    expect(boardClaim).toHaveBeenCalledWith("p1", 7, "s9");
  });

  it("new chat session starts its agent through the outbox, then takes the card", async () => {
    await startCardSession("p1", card, session("s10", "chat"));
    expect(h.store.openSession).toHaveBeenCalledWith("s10");
    expect(createSubmission).toHaveBeenCalledWith("s10", cardPrompt(card), [], "queue");
    expect(chatStart).toHaveBeenCalledWith("s10");
    expect(h.calls).toEqual(["deliver", "claim"]);
  });

  it("chat session gets the pasted images attached, skipping any that cannot be read", async () => {
    const dir = "/home/me/.local/share/io.vlinx.vlxterm/board-images";
    const withImages = { ...card, description: `![image](<${dir}/${SHOT}>) ![image](<${dir}/${MISSING}>)` };
    await sendCardToSession("p1", withImages, session("s3", "chat"));
    expect(boardImageRead).toHaveBeenCalledWith(SHOT);
    expect(createSubmission).toHaveBeenCalledWith("s3", cardPrompt(withImages), [{ mimeType: "image/png", data: SHOT }], "queue");
  });

  it("does not take the card when the chat message is not delivered", async () => {
    h.receipt = undefined;
    await expect(sendCardToSession("p1", card, session("s2", "chat"))).rejects.toThrow();
    expect(boardClaim).not.toHaveBeenCalled();
  });

  it("terminal session gets a bracketed paste without control characters, then Enter, then the card", async () => {
    await sendCardToSession("p1", { ...card, description: "Line one\nLine two\x1b[31m\x07" }, session("s1", "tui"));
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
    await expect(sendCardToSession("p1", card, session("s1", "tui"))).rejects.toThrow();
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
