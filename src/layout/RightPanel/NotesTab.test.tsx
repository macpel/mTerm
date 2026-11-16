// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setLang } from "../../i18n";
import { NotesTab } from "./NotesTab";

const ipc = vi.hoisted(() => ({
  getNoteBoard: vi.fn<() => Promise<string>>(),
  saveNoteBoard: vi.fn(),
  flushNoteBoard: vi.fn(async () => {}),
}));
vi.mock("../../ipc/noteBoard", () => ipc);
vi.mock("../../ipc/events", () => ({ onNoteBoardChanged: async () => () => {} }));
vi.mock("../CenterPane/doc/WysiwygEditor", () => ({
  WysiwygEditor: forwardRef<{ getMarkdown: () => string }, { defaultValue: string; onEdited: () => void }>(
    function Editor({ defaultValue, onEdited }, ref) {
      useImperativeHandle(ref, () => ({ getMarkdown: () => "edited text" }));
      return <button onClick={onEdited}>{defaultValue}</button>;
    },
  ),
}));

beforeEach(() => {
  setLang("en");
  vi.clearAllMocks();
});
afterEach(cleanup);

it("loads the saved note into the editor and saves edits", async () => {
  ipc.getNoteBoard.mockResolvedValue("# Saved note");
  render(<NotesTab />);
  fireEvent.click(await screen.findByText("# Saved note"));
  expect(ipc.saveNoteBoard).toHaveBeenCalledWith("edited text");
});

it("writes unsaved text when the tab closes", async () => {
  ipc.getNoteBoard.mockResolvedValue("");
  const { unmount } = render(<NotesTab />);
  await screen.findByRole("button");
  unmount();
  expect(ipc.flushNoteBoard).toHaveBeenCalled();
});

it("offers a retry when the note cannot be loaded", async () => {
  ipc.getNoteBoard.mockRejectedValueOnce(new Error("offline")).mockResolvedValue("back");
  render(<NotesTab />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(await screen.findByText("back")).toBeTruthy();
});
