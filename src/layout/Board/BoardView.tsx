//! Kanban board of one project, rendered in its center tab: top bar (search, type and tag filters, Review
//! switch, new card) over the columns. It refetches whenever the board changes, from here or from `vboard`.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import Icons from "../../components/Icons";
import { useT } from "../../i18n";
import {
  BOARD_COLUMNS,
  CARD_TYPES,
  boardCardMove,
  boardGet,
  boardSetReview,
  onBoardChanged,
  type BoardCard,
  type BoardColumn as Column,
  type BoardData,
  type CardType,
} from "../../ipc/board";
import { BoardColumn } from "./BoardColumn";
import { TYPE_ICON } from "./BoardCard";
import { CardDetails } from "./CardDetails";
import { allTags, filterCards } from "./filter";
import "./board.css";

export function BoardView({ projectId, hidden }: { projectId: string; hidden: boolean }) {
  const t = useT();
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<CardType[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ card: BoardCard; x: number; y: number } | null>(null);
  /** Card number open in the details panel, or "new" for the new-card form. */
  const [open, setOpen] = useState<number | "new" | null>(null);

  const load = useCallback(() => {
    boardGet(projectId)
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(() => {
    load();
    let stop: (() => void) | undefined;
    let active = true;
    void onBoardChanged(projectId, load).then((off) => {
      if (active) stop = off;
      else off();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [projectId, load]);

  const cards = useMemo(() => filterCards(data?.cards ?? [], { query, types, tags }), [data, query, types, tags]);
  const tagOptions = useMemo(() => allTags(data?.cards ?? []), [data]);
  // Review shows when switched on, and also while cards still sit in it so none disappear.
  const columns = BOARD_COLUMNS.filter(
    (c) => c !== "review" || data?.reviewEnabled || data?.cards.some((card) => card.column === "review"),
  );

  const move = (number: number, column: Column, beforeNumber?: number) => {
    boardCardMove(projectId, number, column, beforeNumber).catch((e) => setError(String(e)));
  };
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const menuItems = (card: BoardCard): MenuItem[] =>
    columns
      .filter((c) => c !== card.column)
      .map((c) => ({ label: t(`board.column.${c}`), onClick: () => move(card.number, c) }));

  return (
    <div className="board" style={hidden ? { display: "none" } : undefined}>
      <div className="board-top">
        <label className="board-search">
          <Icons.search size={13} />
          <input
            value={query}
            placeholder={t("board.search")}
            aria-label={t("board.search")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="board-chips">
          {CARD_TYPES.map((type) => {
            const TypeIcon = TYPE_ICON[type];
            return (
              <button
                key={type}
                type="button"
                className={`board-chip board-type-${type}`}
                aria-pressed={types.includes(type)}
                onClick={() => setTypes((list) => toggle(list, type))}
              >
                <TypeIcon size={11} /> {t(`board.type.${type}`)}
              </button>
            );
          })}
          {tagOptions.map((tag) => (
            <button
              key={tag}
              type="button"
              className="board-chip"
              aria-pressed={tags.includes(tag)}
              onClick={() => setTags((list) => toggle(list, tag))}
            >
              #{tag}
            </button>
          ))}
        </div>
        <label className="board-review">
          <input
            type="checkbox"
            checked={data?.reviewEnabled ?? false}
            onChange={(e) => boardSetReview(projectId, e.target.checked).catch((err) => setError(String(err)))}
          />
          {t("board.review")}
        </label>
        <button type="button" className="vlx-btn vlx-btn-primary board-add" onClick={() => setOpen("new")}>
          <Icons.plus size={12} /> {t("board.addCard")}
        </button>
      </div>
      {error && <div className="board-error" role="alert">{error}</div>}
      {data && data.cards.length === 0 && <div className="board-empty">{t("board.empty")}</div>}
      <div className="board-main">
      <div className="board-cols">
        {columns.map((column) => (
          <BoardColumn
            key={column}
            column={column}
            cards={cards.filter((c) => c.column === column)}
            onOpen={(n) => setOpen(n)}
            onMenu={(card, x, y) => setMenu({ card, x, y })}
            onMove={move}
          />
        ))}
      </div>
      {open !== null && (
        <CardDetails
          key={open}
          projectId={projectId}
          number={open === "new" ? undefined : open}
          onClose={() => setOpen(null)}
        />
      )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.card)} onClose={() => setMenu(null)} />}
    </div>
  );
}
