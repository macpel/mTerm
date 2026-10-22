//! Kanban board of one project, rendered in its center tab: top bar (search, type and tag filters) over the
//! board's own columns, which can be added, renamed, reordered and deleted. Cards are added per column through
//! a dialog. It refetches whenever the board changes, from here or from `vboard`.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import Icons from "../../components/Icons";
import { useT } from "../../i18n";
import {
  CARD_TYPES,
  COLUMN_ROLES,
  boardCardMove,
  boardColumnAdd,
  boardColumnDelete,
  boardColumnMove,
  boardColumnRename,
  boardGet,
  onBoardChanged,
  type BoardCard,
  type BoardColumnInfo,
  type BoardData,
  type CardType,
} from "../../ipc/board";
import { AddCardDialog } from "./AddCardDialog";
import { BoardColumn } from "./BoardColumn";
import { columnLabel } from "./columns";
import { TYPE_ICON } from "./BoardCard";
import { useTermStore } from "../../store/termStore";
import { CardDetails } from "./CardDetails";
import { sendCardToClaude, sendTargets } from "./sendToClaude";
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
  /** Card number open in the details panel. */
  const [open, setOpen] = useState<number | null>(null);
  /** Column whose Add card dialog is open. */
  const [adding, setAdding] = useState<BoardColumnInfo | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  /** Name being typed for a new custom column. */
  const [newColumn, setNewColumn] = useState<string | null>(null);
  const allSessions = useTermStore((st) => st.sessions);
  const runtimes = useTermStore((st) => st.runtimes);
  const claudeSessions = useMemo(() => sendTargets(allSessions, runtimes, projectId), [allSessions, runtimes, projectId]);

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

  const tagOptions = useMemo(() => allTags(data?.cards ?? []), [data]);
  // A selected tag that no card carries any more (removed here or by Claude) has no chip left to clear it,
  // so it stops filtering instead of hiding every card.
  const cards = useMemo(
    () => filterCards(data?.cards ?? [], { query, types, tags: tags.filter((t) => tagOptions.includes(t)) }),
    [data, query, types, tags, tagOptions],
  );
  const columns = data?.columns ?? [];
  const missingRoles = COLUMN_ROLES.filter((role) => role !== "backlog" && !columns.some((c) => c.role === role));

  const report = (e: unknown) => setError(String(e));
  const move = (number: number, column: string, beforeNumber?: number) => {
    boardCardMove(projectId, number, column, beforeNumber).catch(report);
  };
  const addCustomColumn = () => {
    const name = newColumn?.trim();
    setNewColumn(null);
    if (name) boardColumnAdd(projectId, { name }).catch(report);
  };
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const menuItems = (card: BoardCard): MenuItem[] =>
    columns
      .filter((c) => c.id !== card.column)
      .map((c) => ({ label: columnLabel(t, c), onClick: () => move(card.number, c.id) }));
  const addMenuItems: MenuItem[] = [
    ...missingRoles.map((role) => ({ label: t(`board.column.${role}`), onClick: () => void boardColumnAdd(projectId, { role }).catch(report) })),
    ...(missingRoles.length ? [{ label: "", separator: true }] : []),
    { label: t("board.customColumn"), onClick: () => setNewColumn("") },
  ];

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
      </div>
      {error && <div className="board-error" role="alert">{error}</div>}
      {data && data.cards.length === 0 && <div className="board-empty">{t("board.empty")}</div>}
      <div className="board-main">
        <div className="board-cols">
          {columns.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              label={columnLabel(t, column)}
              cards={cards.filter((c) => c.column === column.id)}
              onOpen={(n) => setOpen(n)}
              onMenu={(card, x, y) => setMenu({ card, x, y })}
              onMove={move}
              onAddCard={() => setAdding(column)}
              onRename={(name) => void boardColumnRename(projectId, column.id, name).catch(report)}
              onDelete={() => void boardColumnDelete(projectId, column.id).catch(report)}
              onMoveColumn={(dragged) => void boardColumnMove(projectId, dragged, column.id).catch(report)}
            />
          ))}
          <div className="board-col-new">
            {newColumn !== null ? (
              <input
                aria-label={t("board.columnName")}
                placeholder={t("board.columnName")}
                value={newColumn}
                autoFocus
                onChange={(e) => setNewColumn(e.target.value)}
                onBlur={addCustomColumn}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addCustomColumn();
                  if (e.key === "Escape") setNewColumn(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="board-col-new-btn"
                aria-label={t("board.addColumn")}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setAddMenu({ x: r.left, y: r.bottom });
                }}
              >
                <Icons.plus size={12} /> {t("board.addColumn")}
              </button>
            )}
          </div>
        </div>
        {open !== null && (
          <CardDetails
            key={open}
            projectId={projectId}
            number={open}
            onClose={() => setOpen(null)}
            columns={columns}
            claudeSessions={claudeSessions}
            onSend={(card, target) => sendCardToClaude(projectId, card, target)}
          />
        )}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.card)} onClose={() => setMenu(null)} />}
      {addMenu && <ContextMenu x={addMenu.x} y={addMenu.y} items={addMenuItems} onClose={() => setAddMenu(null)} />}
      {adding && (
        <AddCardDialog projectId={projectId} column={adding.id} columnName={columnLabel(t, adding)} onClose={() => setAdding(null)} />
      )}
    </div>
  );
}
