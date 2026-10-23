import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  useT: () => (key: string, ...args: unknown[]) => (args.length ? `${key}:${args.join(",")}` : key),
  getLocale: () => "en",
  t: (key: string) => key,
}));
vi.mock("../../hooks/nativeViewSuspend", () => ({ useSuspendNativeViews: () => {}, useNativeViewSuspended: () => false }));
vi.mock("../../ipc/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/board")>()),
  boardCardCreate: vi.fn(() => Promise.resolve({})),
}));

import { boardCardCreate } from "../../ipc/board";
import { AddCardDialog } from "./AddCardDialog";

beforeEach(() => vi.clearAllMocks());

describe("AddCardDialog", () => {
  it("creates a card with type, priority, colour and tags in its column", async () => {
    const onClose = vi.fn();
    render(<AddCardDialog projectId="p1" column="c-qa" columnName="QA" onClose={onClose} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("board.fieldTitle"), { target: { value: "Add dark mode" } });
    fireEvent.change(screen.getByLabelText("board.fieldType"), { target: { value: "feature" } });
    fireEvent.change(screen.getByLabelText("board.fieldPriority"), { target: { value: "urgent" } });
    fireEvent.click(screen.getByRole("radio", { name: "board.colour.green" }));
    const tags = screen.getByLabelText("board.fieldTags");
    fireEvent.change(tags, { target: { value: "UI " } });
    fireEvent.keyDown(tags, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "board.add" }));
    await waitFor(() =>
      expect(boardCardCreate).toHaveBeenCalledWith("p1", {
        title: "Add dark mode",
        type: "feature",
        priority: "urgent",
        description: "",
        tags: ["ui"],
        color: "green",
        column: "c-qa",
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Add is disabled without a title", () => {
    render(<AddCardDialog projectId="p1" column="todo" columnName="To Do" onClose={() => {}} />);
    const add = screen.getByRole("button", { name: "board.add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("board.fieldTitle"), { target: { value: "  " } });
    expect(add.disabled).toBe(true);
  });

  it("Enter in the title adds, Escape cancels", async () => {
    const onClose = vi.fn();
    render(<AddCardDialog projectId="p1" column="todo" columnName="To Do" onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(boardCardCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("board.fieldTitle"), { target: { value: "Quick one" } });
    fireEvent.keyDown(screen.getByLabelText("board.fieldTitle"), { key: "Enter" });
    await waitFor(() => expect(boardCardCreate).toHaveBeenCalledWith("p1", expect.objectContaining({ title: "Quick one", column: "todo", color: null })));
  });

  it("shows a backend error inline", async () => {
    vi.mocked(boardCardCreate).mockRejectedValueOnce("A card can have at most 10 tags.");
    render(<AddCardDialog projectId="p1" column="todo" columnName="To Do" onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("board.fieldTitle"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "board.add" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A card can have at most 10 tags.");
  });
});
