//! One board column: header with count, its cards, and a drop zone that appends to the end.
import { useT } from "../../i18n";
import type { BoardCard as Card, BoardColumn as Column } from "../../ipc/board";
import { BoardCard, CARD_MIME } from "./BoardCard";

export function BoardColumn({
  column,
  cards,
  onOpen,
  onMenu,
  onMove,
}: {
  column: Column;
  cards: Card[];
  onOpen: (number: number) => void;
  onMenu: (card: Card, x: number, y: number) => void;
  onMove: (number: number, column: Column, beforeNumber?: number) => void;
}) {
  const t = useT();
  const label = t(`board.column.${column}`);
  return (
    <section
      className="board-col"
      aria-label={label}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(CARD_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const dragged = Number(e.dataTransfer.getData(CARD_MIME));
        if (!dragged) return;
        e.preventDefault();
        onMove(dragged, column);
      }}
    >
      <header className="board-col-head">
        <span>{label}</span>
        <span className="board-count">{cards.length}</span>
      </header>
      <div className="board-col-cards">
        {cards.map((card) => (
          <BoardCard
            key={card.id}
            card={card}
            onOpen={() => onOpen(card.number)}
            onMenu={(x, y) => onMenu(card, x, y)}
            onDropBefore={(dragged) => onMove(dragged, column, card.number)}
          />
        ))}
      </div>
    </section>
  );
}
