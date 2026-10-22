import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard, BoardColumnInfo, BoardData } from "../../ipc/board";

const h = vi.hoisted(() => ({
  data: null as BoardData | null,
  changed: null as null | (() => void),
}));

vi.mock("../../i18n", () => ({
  useT: () => (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
  getLocale: () => "en",
}));
vi.mock("../../hooks/nativeViewSuspend", () => ({ useSuspendNativeViews: () => {}, useNativeViewSuspended: () => false }));
vi.mock("../../ipc/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/board")>()),
  boardGet: vi.fn(() => Promise.resolve(h.data)),
  boardCardMove: vi.fn(() => Promise.resolve()),
  boardCardCreate: vi.fn(() => Promise.resolve({})),
  boardColumnAdd: vi.fn(() => Promise.resolve({})),
  boardColumnRename: vi.fn(() => Promise.resolve()),
  boardColumnMove: vi.fn(() => Promise.resolve()),
  boardColumnDelete: vi.fn(() => Promise.resolve()),
  onBoardChanged: vi.fn((_projectId: string, cb: () => void) => {
    h.changed = cb;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../../store/termStore", () => ({
  useTermStore: (select: (state: { sessions: unknown[]; runtimes: object }) => unknown) => select({ sessions: [], runtimes: {} }),
}));
vi.mock("./sendToClaude", () => ({ sendCardToClaude: vi.fn(), sendTargets: () => [] }));

import {
  boardCardCreate,
  boardCardMove,
  boardColumnAdd,
  boardColumnDelete,
  boardColumnMove,
  boardColumnRename,
  boardGet,
} from "../../ipc/board";
import { BoardView } from "./BoardView";

function card(number: number, over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: `c${number}`,
    number,
    column: "todo",
    position: number,
    type: "task",
    title: `Card ${number}`,
    description: "",
    priority: "medium",
    tags: [],
    color: null,
    claimedBy: null,
    claimedByName: null,
    updatedAt: Math.floor(Date.now() / 1000) - 120,
    updatedBy: { kind: "user", sessionId: null, name: null },
    ...over,
  };
}

const std = (role: NonNullable<BoardColumnInfo["role"]>, position: number): BoardColumnInfo => ({ id: role, name: null, role, position });
const column = (label: string) => screen.getByRole("region", { name: label });

/** jsdom has no DataTransfer; this is enough for HTML5 drag and drop handlers. */
function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (type: string, value: string) => { store[type] = value; },
    getData: (type: string) => store[type] ?? "",
    get types() { return Object.keys(store); },
    effectAllowed: "",
    dropEffect: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.data = {
    columns: [std("backlog", 0), std("todo", 1), std("in_progress", 2), std("done", 3)],
    cards: [
      card(1, { title: "Login crash", type: "bug", tags: ["auth", "ui"], priority: "urgent", color: "red" }),
      card(2, { title: "Dark mode", type: "feature", column: "in_progress", tags: ["ui"], claimedBy: "s1", claimedByName: "Session One" }),
      card(3, { title: "Release notes", column: "backlog", tags: ["docs"] }),
    ],
  };
});

describe("BoardView", () => {
  it("renders columns and cards", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    expect(await screen.findByText("Login crash")).toBeTruthy();
    for (const role of ["backlog", "todo", "in_progress", "done"]) expect(column(`board.column.${role}`)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "board.column.review" })).toBeNull();
    expect(within(column("board.column.in_progress")).getByText("board.takenBy:Session One")).toBeTruthy();
    expect(within(column("board.column.todo")).getByText("#1")).toBeTruthy();
  });

  it("shows custom column names and the Review column only when the board has one", async () => {
    h.data!.columns.splice(3, 0, std("review", 2.5), { id: "c-qa", name: "QA", role: null, position: 2.7 });
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    expect(column("board.column.review")).toBeTruthy();
    expect(column("QA")).toBeTruthy();
  });

  it("has no top + Card button or Review switch", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.querySelector(".board-top .board-add")).toBeNull();
    expect(within(column("board.column.todo")).getByRole("button", { name: "board.addCardHere" })).toBeTruthy();
  });

  it("+ Card at the bottom of a column opens the Add card dialog for that column", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.click(within(column("board.column.in_progress")).getByRole("button", { name: "board.addCardHere" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("board.fieldTitle"), { target: { value: "From the column" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "board.add" }));
    await waitFor(() =>
      expect(boardCardCreate).toHaveBeenCalledWith("p1", expect.objectContaining({ title: "From the column", column: "in_progress" })),
    );
  });

  it("column menu adds a card, renames and deletes", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    const openMenu = () => fireEvent.click(within(column("board.column.todo")).getByRole("button", { name: "board.columnMenu" }));
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "board.addCardMenu" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "board.renameColumn" }));
    const input = screen.getByLabelText("board.columnName");
    fireEvent.change(input, { target: { value: "Ready" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(boardColumnRename).toHaveBeenCalledWith("p1", "todo", "Ready");
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "board.deleteColumn" }));
    expect(boardColumnDelete).toHaveBeenCalledWith("p1", "todo");
  });

  it("Backlog has no drag handle or column menu", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    const backlog = column("board.column.backlog");
    expect(within(backlog).queryByRole("button", { name: "board.columnMenu" })).toBeNull();
    expect(within(backlog).queryByTitle("board.dragColumn")).toBeNull();
    expect(within(backlog).getByRole("button", { name: "board.addCardHere" })).toBeTruthy();
  });

  it("Add column offers the missing standard columns and a custom one", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.click(screen.getByRole("button", { name: "board.addColumn" }));
    expect(await screen.findByRole("menuitem", { name: "board.column.review" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "board.column.todo" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "board.column.review" }));
    expect(boardColumnAdd).toHaveBeenCalledWith("p1", { role: "review" });
    fireEvent.click(screen.getByRole("button", { name: "board.addColumn" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "board.customColumn" }));
    const input = screen.getByLabelText("board.columnName");
    fireEvent.change(input, { target: { value: "QA" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(boardColumnAdd).toHaveBeenCalledWith("p1", { name: "QA" });
  });

  it("dragging a column by its handle onto another column moves it before that one", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    const transfer = dataTransfer();
    fireEvent.dragStart(within(column("board.column.done")).getByTitle("board.dragColumn"), { dataTransfer: transfer });
    const target = column("board.column.in_progress");
    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(boardColumnMove).toHaveBeenCalledWith("p1", "done", "in_progress");
  });

  it("shows a card's colour as a stripe", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    const title = await screen.findByText("Login crash");
    expect(title.closest(".board-card")?.getAttribute("data-color")).toBe("red");
    expect(screen.getByText("Dark mode").closest(".board-card")?.hasAttribute("data-color")).toBe(false);
  });

  it("search narrows cards", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.change(screen.getByPlaceholderText("board.search"), { target: { value: "dark" } });
    expect(screen.queryByText("Login crash")).toBeNull();
    expect(screen.getByText("Dark mode")).toBeTruthy();
  });

  it("tag chip filters", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.click(screen.getByRole("button", { name: "#docs" }));
    expect(screen.queryByText("Login crash")).toBeNull();
    expect(screen.getByText("Release notes")).toBeTruthy();
  });

  it("drops a selected tag filter when no card has that tag any more", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.click(screen.getByRole("button", { name: "#docs" }));
    expect(screen.queryByText("Login crash")).toBeNull();
    h.data = { ...h.data!, cards: h.data!.cards.map((c) => ({ ...c, tags: c.tags.filter((t) => t !== "docs") })) };
    h.changed?.();
    expect(await screen.findByText("Login crash")).toBeTruthy();
  });

  it("Move to lists the board's columns and calls boardCardMove", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.click(within(column("board.column.todo")).getByRole("button", { name: "board.cardMenu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "board.column.done" }));
    expect(boardCardMove).toHaveBeenCalledWith("p1", 1, "done", undefined);
  });

  it("refetches on board changed event", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    h.data = { ...h.data!, cards: [card(9, { title: "Added by Claude" })] };
    h.changed?.();
    expect(await screen.findByText("Added by Claude")).toBeTruthy();
    await waitFor(() => expect(boardGet).toHaveBeenCalledTimes(2));
  });
});
