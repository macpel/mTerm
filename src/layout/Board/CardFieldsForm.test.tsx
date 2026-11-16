import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n", () => ({
  useT: () => (key: string) => key,
  getLocale: () => "en",
  t: (key: string) => key,
}));
vi.mock("../../ipc/board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ipc/board")>()),
  boardImageSave: vi.fn(() => Promise.resolve("C:/data/board-images/abc-1.png")),
}));

import { boardImageSave, type CardFields } from "../../ipc/board";
import { CardFieldsForm, EMPTY_FIELDS } from "./CardFieldsForm";

function Form({ description }: { description: string }) {
  const [fields, setFields] = useState<CardFields>({ ...EMPTY_FIELDS, description });
  return <CardFieldsForm fields={fields} onChange={(key, value) => setFields((f) => ({ ...f, [key]: value }))} />;
}

function clipboard(files: File[], text = "") {
  return {
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: () => text,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("CardFieldsForm image paste", () => {
  it("saves a pasted image and links it at the cursor", async () => {
    render(<Form description="before after" />);
    const input = screen.getByLabelText("board.fieldDescription") as HTMLTextAreaElement;
    input.setSelectionRange(7, 7);
    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(input, { clipboardData: clipboard([file]) });
    await waitFor(() => expect(input.value).toBe("before ![image](<C:/data/board-images/abc-1.png>)after"));
    expect(boardImageSave).toHaveBeenCalledWith(expect.any(Uint8Array), "png");
  });

  it("leaves a text paste alone", () => {
    render(<Form description="" />);
    const input = screen.getByLabelText("board.fieldDescription");
    fireEvent.paste(input, { clipboardData: clipboard([], "hello") });
    expect(boardImageSave).not.toHaveBeenCalled();
  });

  it("says so when the image cannot be saved", async () => {
    vi.mocked(boardImageSave).mockRejectedValueOnce(new Error("disk full"));
    render(<Form description="" />);
    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("board.fieldDescription"), { clipboardData: clipboard([file]) });
    expect(await screen.findByText("board.imagePasteFailed")).toBeTruthy();
  });
});
