//! One card on the board: number, type, title, priority, tags, last change and who has taken it.
import type React from "react";
import Icons from "../../components/Icons";
import { getLocale, useT } from "../../i18n";
import type { BoardCard as Card, CardType } from "../../ipc/board";

export const TYPE_ICON: Record<CardType, (props: { size?: number }) => React.ReactNode> = {
  task: Icons.check,
  bug: Icons.warn,
  feature: Icons.sparkle,
  epic: Icons.layers,
};

/** "5 min. ago" in the UI language, from unix seconds. */
export function ago(seconds: number, locale = getLocale()): string {
  const diff = seconds - Date.now() / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(diff) >= size) return format.format(Math.round(diff / size), unit);
  }
  return format.format(0, "second");
}

export const CARD_MIME = "application/x-board-card";

export function BoardCard({
  card,
  onOpen,
  onMenu,
  onDropBefore,
}: {
  card: Card;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
  /** A dragged card was dropped onto this one: place it right before. */
  onDropBefore: (dragged: number) => void;
}) {
  const t = useT();
  const TypeIcon = TYPE_ICON[card.type];
  const who = card.updatedBy.kind === "user" ? t("board.byYou") : card.updatedBy.name ?? "Claude";
  return (
    <div
      className="board-card"
      draggable
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(CARD_MIME, String(card.number));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(CARD_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        const dragged = Number(e.dataTransfer.getData(CARD_MIME));
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation();
        if (dragged !== card.number) onDropBefore(dragged);
      }}
    >
      <div className="board-card-head">
        <span className={`board-type board-type-${card.type}`} title={t(`board.type.${card.type}`)}>
          <TypeIcon size={12} />
        </span>
        <span className="board-num">#{card.number}</span>
        <span className={`board-prio board-prio-${card.priority}`} title={t(`board.priority.${card.priority}`)}>
          {t(`board.priority.${card.priority}`)}
        </span>
        <button
          type="button"
          className="board-card-menu"
          aria-label={t("board.cardMenu")}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.left, r.bottom);
          }}
        >
          <Icons.dotsV size={12} />
        </button>
      </div>
      <div className="board-card-title">{card.title}</div>
      {card.tags.length > 0 && (
        <div className="board-tags">
          {card.tags.map((tag) => (
            <span key={tag} className="board-tag">#{tag}</span>
          ))}
        </div>
      )}
      <div className="board-card-foot">
        {card.claimedByName && <span className="board-taken">{t("board.takenBy", card.claimedByName)}</span>}
        <span className="board-when">{who} · {ago(card.updatedAt)}</span>
      </div>
    </div>
  );
}
