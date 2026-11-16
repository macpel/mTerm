//! Unsaved "Untitled" drafts kept in local storage so they survive an app restart. Keyed by doc tab ID.

import type { DocMode } from "./docTab";

const DRAFTS_KEY = "vlx-doc-drafts";

export interface StoredDraft {
  title: string;
  content: string;
  mode: DocMode;
}

export function loadDrafts(): Record<string, StoredDraft> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredDraft>) : {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts: Record<string, StoredDraft>) {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(DRAFTS_KEY);
    else localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    /* Ignore unavailable or full local storage. */
  }
}

/** Stores a draft; an empty draft is removed instead so blank tabs are not restored. */
export function saveDraft(id: string, draft: StoredDraft) {
  if (draft.content === "") {
    removeDraft(id);
    return;
  }
  writeDrafts({ ...loadDrafts(), [id]: draft });
}

export function removeDraft(id: string) {
  const drafts = loadDrafts();
  if (!(id in drafts)) return;
  delete drafts[id];
  writeDrafts(drafts);
}
