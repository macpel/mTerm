//! Client for the per-project Kanban board (`board_*` commands, `board://changed` event).
import { invoke, listen } from "./transport";

/** Roles of the standard columns, in their default order; custom columns have none. */
export const COLUMN_ROLES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export const CARD_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;
export const CARD_TYPES = ["task", "bug", "feature", "epic"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type ColumnRole = (typeof COLUMN_ROLES)[number];
export type CardColor = (typeof CARD_COLORS)[number];

export interface BoardColumnInfo {
  /** The role for standard columns (`todo`…), `c-xxxxxxxx` for custom ones. */
  id: string;
  /** Null until a standard column is renamed; the app then shows its translated default name. */
  name: string | null;
  role: ColumnRole | null;
  position: number;
}
export type CardType = (typeof CARD_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface BoardCard {
  id: string;
  number: number;
  /** Id of the column the card is in. */
  column: string;
  position: number;
  type: CardType;
  title: string;
  description: string;
  priority: Priority;
  tags: string[];
  color: CardColor | null;
  claimedBy: string | null;
  claimedByName: string | null;
  /** Unix seconds. */
  updatedAt: number;
  updatedBy: { kind: "user" | "agent"; sessionId: string | null; name: string | null };
}

export interface BoardData {
  columns: BoardColumnInfo[];
  cards: BoardCard[];
}

/** What a history entry records; written by the backend's board store. "noted" only appears in older history. */
export type CardAction = "created" | "moved" | "edited" | "tagged" | "noted" | "claimed";

export interface CardEvent {
  id: string;
  actorKind: "user" | "agent";
  actorName: string | null;
  action: CardAction;
  detail: string;
  createdAt: number;
}

export type CardDetail = BoardCard & { history: CardEvent[] };

export interface CardFields {
  title: string;
  type: CardType;
  description: string;
  priority: Priority;
  tags: string[];
  color: CardColor | null;
}

export const boardGet = (projectId: string) => invoke<BoardData>("board_get", { projectId });
export const boardCardCreate = (projectId: string, fields: CardFields & { column?: string }) =>
  invoke<BoardCard>("board_card_create", { projectId, ...fields });
export const boardCardUpdate = (projectId: string, number: number, fields: Partial<CardFields>) =>
  invoke<BoardCard>("board_card_update", { projectId, number, ...fields });
export const boardCardMove = (projectId: string, number: number, column: string, beforeNumber?: number) =>
  invoke<BoardCard>("board_card_move", { projectId, number, column, beforeNumber });
export const boardCardDelete = (projectId: string, number: number) => invoke<void>("board_card_delete", { projectId, number });
export const boardCardDetail = (projectId: string, number: number) => invoke<CardDetail>("board_card_detail", { projectId, number });
/** Add a custom column by name, or a missing standard column by role. */
export const boardColumnAdd = (projectId: string, column: { name?: string; role?: ColumnRole }) =>
  invoke<BoardColumnInfo>("board_column_add", { projectId, ...column });
export const boardColumnRename = (projectId: string, columnId: string, name: string) =>
  invoke<void>("board_column_rename", { projectId, columnId, name });
export const boardColumnMove = (projectId: string, columnId: string, beforeColumnId?: string) =>
  invoke<void>("board_column_move", { projectId, columnId, beforeColumnId });
/** Delete a column; its cards move to Backlog. */
export const boardColumnDelete = (projectId: string, columnId: string) => invoke<void>("board_column_delete", { projectId, columnId });
export const boardClaim = (projectId: string, number: number, sessionId: string) =>
  invoke<BoardCard>("board_claim", { projectId, number, sessionId });

/** Calls `cb` whenever this project's board changes, from the app or from a `vboard` command. */
export function onBoardChanged(projectId: string, cb: () => void): Promise<() => void> {
  return listen<{ projectId?: string }>("board://changed", (payload) => {
    if (payload?.projectId === projectId) cb();
  });
}
