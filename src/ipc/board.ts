//! Client for the per-project Kanban board (`board_*` commands, `board://changed` event).
import { invoke, listen } from "./transport";

export const BOARD_COLUMNS = ["backlog", "todo", "in_progress", "review", "done"] as const;
export const CARD_TYPES = ["task", "bug", "feature", "epic"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export type CardType = (typeof CARD_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface BoardCard {
  id: string;
  number: number;
  column: BoardColumn;
  position: number;
  type: CardType;
  title: string;
  description: string;
  priority: Priority;
  tags: string[];
  claimedBy: string | null;
  claimedByName: string | null;
  /** Unix seconds. */
  updatedAt: number;
  updatedBy: { kind: "user" | "agent"; sessionId: string | null; name: string | null };
}

export interface BoardData {
  reviewEnabled: boolean;
  cards: BoardCard[];
}

export interface CardNote {
  id: string;
  authorKind: "user" | "agent";
  authorName: string | null;
  text: string;
  createdAt: number;
}

/** What a history entry records; written by the backend's board store. */
export type CardAction = "created" | "moved" | "edited" | "tagged" | "noted" | "claimed";

export interface CardEvent {
  id: string;
  actorKind: "user" | "agent";
  actorName: string | null;
  action: CardAction;
  detail: string;
  createdAt: number;
}

export type CardDetail = BoardCard & { notes: CardNote[]; history: CardEvent[] };

export interface CardFields {
  title: string;
  type: CardType;
  description: string;
  priority: Priority;
  tags: string[];
}

export const boardGet = (projectId: string) => invoke<BoardData>("board_get", { projectId });
export const boardCardCreate = (projectId: string, fields: CardFields & { column?: BoardColumn }) =>
  invoke<BoardCard>("board_card_create", { projectId, ...fields });
export const boardCardUpdate = (projectId: string, number: number, fields: Partial<CardFields>) =>
  invoke<BoardCard>("board_card_update", { projectId, number, ...fields });
export const boardCardMove = (projectId: string, number: number, column: BoardColumn, beforeNumber?: number) =>
  invoke<BoardCard>("board_card_move", { projectId, number, column, beforeNumber });
export const boardCardDelete = (projectId: string, number: number) => invoke<void>("board_card_delete", { projectId, number });
export const boardNoteAdd = (projectId: string, number: number, text: string) =>
  invoke<BoardCard>("board_note_add", { projectId, number, text });
export const boardCardDetail = (projectId: string, number: number) => invoke<CardDetail>("board_card_detail", { projectId, number });
export const boardSetReview = (projectId: string, enabled: boolean) => invoke<void>("board_set_review", { projectId, enabled });
export const boardClaim = (projectId: string, number: number, sessionId: string) =>
  invoke<BoardCard>("board_claim", { projectId, number, sessionId });

/** Calls `cb` whenever this project's board changes, from the app or from a `vboard` command. */
export function onBoardChanged(projectId: string, cb: () => void): Promise<() => void> {
  return listen<{ projectId?: string }>("board://changed", (payload) => {
    if (payload?.projectId === projectId) cb();
  });
}
