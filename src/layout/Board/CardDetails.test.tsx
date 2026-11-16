import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardDetail } from "../../ipc/board";
import type { Session } from "../../types";

vi.mock("../../i18n", () => ({
  useT: () => (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
  getLocale: () => "en",
  t: (key: string) => key,
}));
const h = vi.hoisted(() => ({ changed: null as null | (() => void) }));

vi.mock("../../hooks/nativeViewSuspend", () => ({ useSuspendNativeViews: () => {}, useNativeViewSuspended: () => false }));
vi.mock("../../ipc/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/board")>()),
  boardCardDetail: vi.fn(),
  boardCardCreate: vi.fn(() => Promise.resolve({})),
  boardCardUpdate: vi.fn(() => Promise.resolve({})),
  boardCardDelete: vi.fn(() => Promise.resolve()),
  onBoardChanged: vi.fn((_projectId: string, cb: () => void) => {
    h.changed = cb;
    return Promise.resolve(() => {});
  }),
}));

import { boardCardDetail, boardCardUpdate } from "../../ipc/board";
import { CardDetails } from "./CardDetails";

const detail: CardDetail = {
  id: "c7",
  number: 7,
  column: "in_progress",
  position: 1,
  type: "bug",
  title: "Login crash",
  description: "**Empty** password",
  priority: "high",
  tags: ["auth"],
  color: null,
  claimedBy: null,
  claimedByName: null,
  updatedAt: 0,
  updatedBy: { kind: "agent", sessionId: "s1", name: "Session One" },
  history: [
    { id: "h2", actorKind: "agent", actorName: "Session One", action: "moved", detail: "in_progress", createdAt: 20 },
    { id: "h1", actorKind: "user", actorName: null, action: "created", detail: "", createdAt: 10 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(boardCardDetail).mockResolvedValue(detail);
});

describe("CardDetails", () => {
  it("saves edits including a colour, and none clears it", async () => {
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} />);
    await screen.findByText("Empty");
    fireEvent.click(screen.getByRole("radio", { name: "board.colour.purple" }));
    fireEvent.click(screen.getByRole("button", { name: "board.save" }));
    await waitFor(() =>
      expect(boardCardUpdate).toHaveBeenCalledWith("p1", 7, expect.objectContaining({ title: "Login crash", color: "purple" })),
    );
    fireEvent.click(screen.getByRole("radio", { name: "board.colour.none" }));
    fireEvent.click(screen.getByRole("button", { name: "board.save" }));
    await waitFor(() => expect(boardCardUpdate).toHaveBeenLastCalledWith("p1", 7, expect.objectContaining({ color: null })));
  });

  it("save disabled when the title is cleared", async () => {
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} />);
    await screen.findByText("Empty");
    const save = screen.getByRole("button", { name: "board.save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("board.fieldTitle"), { target: { value: "   " } });
    expect(save.disabled).toBe(true);
  });

  it("shows backend error inline", async () => {
    vi.mocked(boardCardUpdate).mockRejectedValueOnce("A card can have at most 10 tags.");
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} />);
    await screen.findByText("Empty");
    fireEvent.click(screen.getByRole("button", { name: "board.save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A card can have at most 10 tags.");
  });

  it("shows the description as Markdown, and Write edits the source", async () => {
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} />);
    expect((await screen.findByText("Empty")).closest("strong")).not.toBeNull();
    expect(screen.queryByLabelText("board.notes")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "board.write" }));
    expect((screen.getByLabelText("board.fieldDescription") as HTMLTextAreaElement).value).toBe("**Empty** password");
  });

  it("lists history newest first", async () => {
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} />);
    const list = await screen.findByRole("list", { name: "board.history" });
    const items = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("board.action.moved");
    expect(items[0]).toContain("board.column.in_progress");
    expect(items[1]).toContain("board.action.created");
  });

  it("Send to Claude offers a new session and the project's Claude sessions", async () => {
    const onSend = vi.fn();
    const sessions = [{ id: "s1", name: "Session One" }] as Session[];
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} claudeSessions={sessions} onSend={onSend} />);
    await screen.findByText("Empty");
    fireEvent.click(screen.getByRole("button", { name: "board.sendToClaude" }));
    expect(await screen.findByRole("menuitem", { name: "Session One" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "board.newSession" }));
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ number: 7 }), "new");
  });

  it("keeps unsaved edits when the board changes elsewhere", async () => {
    render(<CardDetails projectId="p1" number={7} onClose={() => {}} />);
    await screen.findByText("Empty");
    fireEvent.click(screen.getByRole("tab", { name: "board.write" }));
    const description = screen.getByLabelText("board.fieldDescription") as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "Typed but not saved" } });
    vi.mocked(boardCardDetail).mockResolvedValue({
      ...detail,
      history: [{ id: "h3", actorKind: "agent", actorName: "Claude was here", action: "edited", detail: "", createdAt: 30 }, ...detail.history],
    });
    h.changed?.();
    expect(await screen.findByText(/Claude was here/)).toBeTruthy();
    expect(description.value).toBe("Typed but not saved");
  });
});
