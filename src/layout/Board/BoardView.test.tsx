import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardCard, BoardData } from "../../ipc/board";

const h = vi.hoisted(() => ({
  data: null as BoardData | null,
  changed: null as null | (() => void),
}));

vi.mock("../../i18n", () => ({
  useT: () => (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
  getLocale: () => "en",
}));
vi.mock("../../ipc/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/board")>()),
  boardGet: vi.fn(() => Promise.resolve(h.data)),
  boardCardMove: vi.fn(() => Promise.resolve()),
  boardSetReview: vi.fn(() => Promise.resolve()),
  onBoardChanged: vi.fn((_projectId: string, cb: () => void) => {
    h.changed = cb;
    return Promise.resolve(() => {});
  }),
}));

import { boardCardMove, boardGet } from "../../ipc/board";
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
    claimedBy: null,
    claimedByName: null,
    updatedAt: Math.floor(Date.now() / 1000) - 120,
    updatedBy: { kind: "user", sessionId: null, name: null },
    ...over,
  };
}

const column = (key: string) => screen.getByRole("region", { name: `board.column.${key}` });

beforeEach(() => {
  vi.clearAllMocks();
  h.data = {
    reviewEnabled: false,
    cards: [
      card(1, { title: "Login crash", type: "bug", tags: ["auth", "ui"], priority: "urgent" }),
      card(2, { title: "Dark mode", type: "feature", column: "in_progress", tags: ["ui"], claimedBy: "s1", claimedByName: "Session One" }),
      card(3, { title: "Release notes", column: "backlog", tags: ["docs"] }),
    ],
  };
});

describe("BoardView", () => {
  it("renders columns and cards", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    expect(await screen.findByText("Login crash")).toBeTruthy();
    for (const key of ["backlog", "todo", "in_progress", "done"]) expect(column(key)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "board.column.review" })).toBeNull();
    expect(within(column("in_progress")).getByText("Dark mode")).toBeTruthy();
    expect(within(column("in_progress")).getByText("board.takenBy:Session One")).toBeTruthy();
    expect(within(column("todo")).getByText("#1")).toBeTruthy();
  });

  it("keeps_review_column_while_it_holds_cards", async () => {
    h.data!.cards.push(card(4, { title: "Waiting for review", column: "review" }));
    render(<BoardView projectId="p1" hidden={false} />);
    expect(await screen.findByText("Waiting for review")).toBeTruthy();
    expect(within(column("review")).getByText("Waiting for review")).toBeTruthy();
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

  it("Move to calls boardCardMove", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    fireEvent.click(within(column("todo")).getByRole("button", { name: "board.cardMenu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "board.column.done" }));
    expect(boardCardMove).toHaveBeenCalledWith("p1", 1, "done", undefined);
  });

  it("refetches on board changed event", async () => {
    render(<BoardView projectId="p1" hidden={false} />);
    await screen.findByText("Login crash");
    expect(boardGet).toHaveBeenCalledTimes(1);
    h.data = { reviewEnabled: false, cards: [card(9, { title: "Added by Claude" })] };
    h.changed?.();
    expect(await screen.findByText("Added by Claude")).toBeTruthy();
    await waitFor(() => expect(boardGet).toHaveBeenCalledTimes(2));
  });
});
