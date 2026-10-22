//! Board search and filters. Search matches title, description and tags; a card passes the type filter if
//! its type is selected and the tag filter if it has any selected tag. Empty selections let everything pass.
import type { BoardCard, CardType } from "../../ipc/board";

export interface BoardFilter {
  query: string;
  types: CardType[];
  tags: string[];
}

export function filterCards(cards: BoardCard[], { query, types, tags }: BoardFilter): BoardCard[] {
  const q = query.trim().toLowerCase();
  return cards.filter(
    (c) =>
      (types.length === 0 || types.includes(c.type)) &&
      (tags.length === 0 || c.tags.some((t) => tags.includes(t))) &&
      (!q ||
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.tags.some((t) => t.includes(q))),
  );
}

export function allTags(cards: BoardCard[]): string[] {
  return [...new Set(cards.flatMap((c) => c.tags))].sort();
}
