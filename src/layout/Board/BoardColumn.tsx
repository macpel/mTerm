//! One board column: header (drag handle, name, count, ⋯ menu), its cards, and a + Card button at the bottom.
//! Dropping a card appends it; dropping another column's header moves that column before this one.
//! Backlog is fixed: no handle and no menu.
import { useState } from "react";
import { ContextMenu } from "../../components/ContextMenu";
import Icons from "../../components/Icons";
import { useT } from "../../i18n";
import type { BoardCard as Card, BoardColumnInfo } from "../../ipc/board";
import { BoardCard, CARD_MIME } from "./BoardCard";

export const COLUMN_MIME = "application/x-board-column";

export function BoardColumn({
  column,
  label,
  cards,
  onOpen,
  onMenu,
  onMove,
  onAddCard,
  onRename,
  onDelete,
  onMoveColumn,
}: {
  column: BoardColumnInfo;
  label: string;
  cards: Card[];
  onOpen: (number: number) => void;
  onMenu: (card: Card, x: number, y: number) => void;
  onMove: (number: number, column: string, beforeNumber?: number) => void;
  onAddCard: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** A column was dropped here: move it before this one. */
  onMoveColumn: (dragged: string) => void;
}) {
  const t = useT();
  const fixed = column.role === "backlog";
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const commitRename = () => {
    if (renaming !== null && renaming.trim() && renaming.trim() !== label) onRename(renaming.trim());
    setRenaming(null);
  };
  const dragColumn = fixed
    ? {}
    : {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.dataTransfer.setData(COLUMN_MIME, column.id);
          e.dataTransfer.effectAllowed = "move";
        },
      };

  return (
    <section
      className="board-col"
      aria-label={label}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        if (types.includes(CARD_MIME) || (!fixed && types.includes(COLUMN_MIME))) e.preventDefault();
      }}
      onDrop={(e) => {
        const draggedColumn = e.dataTransfer.getData(COLUMN_MIME);
        if (draggedColumn) {
          e.preventDefault();
          if (!fixed && draggedColumn !== column.id) onMoveColumn(draggedColumn);
          return;
        }
        const dragged = Number(e.dataTransfer.getData(CARD_MIME));
        if (!dragged) return;
        e.preventDefault();
        onMove(dragged, column.id);
      }}
    >
      <header className="board-col-head">
        {!fixed && (
          <span className="board-col-handle" title={t("board.dragColumn")} {...dragColumn}>
            <Icons.grid size={12} />
          </span>
        )}
        <span className={`board-col-dot board-col-dot-${column.role ?? "custom"}`} />
        {renaming !== null ? (
          <input
            className="board-col-rename"
            aria-label={t("board.columnName")}
            value={renaming}
            autoFocus
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <span className="board-col-name" {...dragColumn}>{label}</span>
        )}
        <span className="board-count">{cards.length}</span>
        {!fixed && (
          <button
            type="button"
            className="board-card-menu"
            aria-label={t("board.columnMenu")}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom });
            }}
          >
            <Icons.more size={13} />
          </button>
        )}
      </header>
      <div className="board-col-cards">
        {cards.length === 0 && <div className="board-col-empty">{t(fixed ? "board.nothingQueued" : "board.noCards")}</div>}
        {cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            onOpen={() => onOpen(card.number)}
            onMenu={(x, y) => onMenu(card, x, y)}
            onDropBefore={(dragged) => onMove(dragged, column.id, card.number)}
          />
        ))}
      </div>
      <button type="button" className="board-col-add" onClick={onAddCard}>
        <Icons.plus size={12} /> {t("board.addCardHere")}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t("board.addCardMenu"), icon: <Icons.plus size={13} />, onClick: onAddCard },
            { label: t("board.renameColumn"), icon: <Icons.rename size={13} />, onClick: () => setRenaming(label) },
            { label: "", separator: true },
            { label: t("board.deleteColumn"), icon: <Icons.trash size={13} />, danger: true, onClick: onDelete },
          ]}
        />
      )}
    </section>
  );
}
