//! The notes board: one free-form Markdown note stored in the backend database and shown in the right panel.

import { invoke } from "./transport";

const SAVE_DEBOUNCE_MS = 400;

/** Body waiting for the debounce to run out; `null` when nothing is unsaved. */
let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Read the board's Markdown (empty string when it was never saved). */
export const getNoteBoard = () => invoke<string>("get_note_board");

/** Save the board's Markdown after a short pause in typing; the last call wins. */
export function saveNoteBoard(body: string): void {
  pending = body;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushNoteBoard(), SAVE_DEBOUNCE_MS);
}

/** Write any unsaved body now. `timeoutMs` caps the wait, as for `flushNow` in `settingsSync.ts`. */
export async function flushNoteBoard(timeoutMs?: number): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const body = pending;
  pending = null;
  if (body === null) return;
  const write = invoke("set_note_board", { body }).catch(() => {
    /* The backend is unavailable; the text stays in the open editor and the next edit retries. */
  });
  if (timeoutMs === undefined) {
    await write;
    return;
  }
  let bell: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([write, new Promise<void>((resolve) => { bell = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(bell);
}
