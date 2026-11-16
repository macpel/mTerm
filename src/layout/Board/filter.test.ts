import { describe, expect, it } from "vitest";
import type { BoardCard } from "../../ipc/board";
import { allTags, filterCards } from "./filter";

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
    updatedAt: 0,
    updatedBy: { kind: "user", sessionId: null, name: null },
    ...over,
  };
}

const cards = [
  card(1, { title: "Login crash", type: "bug", tags: ["auth", "ui"] }),
  card(2, { title: "Dark mode", type: "feature", description: "Add a THEME switch", tags: ["ui"] }),
  card(3, { title: "Release notes", type: "task", tags: ["docs"] }),
];
const numbers = (list: BoardCard[]) => list.map((c) => c.number);

describe("filterCards", () => {
  it("matches query in description", () => {
    expect(numbers(filterCards(cards, { query: "theme", types: [], tags: [] }))).toEqual([2]);
  });

  it("matches query in tags", () => {
    expect(numbers(filterCards(cards, { query: "DOCS", types: [], tags: [] }))).toEqual([3]);
  });

  it("type filter ORs selected types", () => {
    expect(numbers(filterCards(cards, { query: "", types: ["bug", "task"], tags: [] }))).toEqual([1, 3]);
  });

  it("tag filter matches any selected tag", () => {
    expect(numbers(filterCards(cards, { query: "", types: [], tags: ["auth", "docs"] }))).toEqual([1, 3]);
  });

  it("empty filters return all cards", () => {
    expect(numbers(filterCards(cards, { query: "  ", types: [], tags: [] }))).toEqual([1, 2, 3]);
  });
});

describe("allTags", () => {
  it("allTags is sorted and unique", () => {
    expect(allTags(cards)).toEqual(["auth", "docs", "ui"]);
  });
});
