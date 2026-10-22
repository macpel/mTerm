//! Side panel of the board: the new-card form, or one card's fields, notes thread and history.
import { useCallback, useEffect, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import Icons from "../../components/Icons";
import { useT } from "../../i18n";
import {
  CARD_TYPES,
  PRIORITIES,
  boardCardCreate,
  boardCardDelete,
  boardCardDetail,
  boardCardUpdate,
  boardNoteAdd,
  onBoardChanged,
  type BoardCard,
  type BoardColumn,
  type CardAction,
  type CardDetail,
  type CardFields,
} from "../../ipc/board";
import type { Session } from "../../types";
import { ago } from "./BoardCard";

const EMPTY: CardFields = { title: "", type: "task", priority: "medium", description: "", tags: [] };

export function CardDetails({
  projectId,
  number,
  onClose,
  claudeSessions = [],
  onSend,
}: {
  projectId: string;
  /** Card to show; omitted for the new-card form. */
  number?: number;
  onClose: () => void;
  /** The project's Claude sessions offered by "Send to Claude". */
  claudeSessions?: Session[];
  onSend?: (card: BoardCard, target: "new" | Session) => Promise<void> | void;
}) {
  const t = useT();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [fields, setFields] = useState<CardFields>(EMPTY);
  const [tagDraft, setTagDraft] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number } | null>(null);

  /** Refresh the card. The form is reset only on first load and after a save, so a change made elsewhere on
   * the board (often by a Claude session) never overwrites what the user is typing. */
  const load = useCallback((resetFields: boolean) => {
    if (number === undefined) return;
    boardCardDetail(projectId, number)
      .then((d) => {
        setCard(d);
        if (resetFields) setFields({ title: d.title, type: d.type, priority: d.priority, description: d.description, tags: d.tags });
      })
      .catch((e) => setError(String(e)));
  }, [projectId, number]);

  useEffect(() => {
    load(true);
    if (number === undefined) return;
    let stop: (() => void) | undefined;
    let active = true;
    void onBoardChanged(projectId, () => load(false)).then((off) => {
      if (active) stop = off;
      else off();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [projectId, number, load]);

  const set = <K extends keyof CardFields>(key: K, value: CardFields[K]) => setFields((f) => ({ ...f, [key]: value }));
  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (tag && !fields.tags.includes(tag)) set("tags", [...fields.tags, tag]);
    setTagDraft("");
  };
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await action();
      after?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    number === undefined
      ? run(() => boardCardCreate(projectId, { ...fields, title: fields.title.trim() }), onClose)
      : run(() => boardCardUpdate(projectId, number, { ...fields, title: fields.title.trim() }), () => load(true));
  const who = (kind: "user" | "agent", name: string | null) => (kind === "user" ? t("board.byYou") : name ?? "Claude");
  const actionDetail = (action: CardAction, detail: string) =>
    action === "moved" && detail ? t(`board.column.${detail as BoardColumn}`) : detail;

  return (
    <aside className="board-details" aria-label={number === undefined ? t("board.newCard") : `#${number}`}>
      <header className="board-details-head">
        <strong>{number === undefined ? t("board.newCard") : `#${number}`}</strong>
        <button type="button" className="board-card-menu" aria-label={t("common.close")} onClick={onClose}>
          <Icons.x size={13} />
        </button>
      </header>
      <div className="board-details-body">
        <label className="board-field">
          <span>{t("board.fieldTitle")}</span>
          <input aria-label={t("board.fieldTitle")} value={fields.title} autoFocus onChange={(e) => set("title", e.target.value)} />
        </label>
        <div className="board-field-row">
          <label className="board-field">
            <span>{t("board.fieldType")}</span>
            <select aria-label={t("board.fieldType")} value={fields.type} onChange={(e) => set("type", e.target.value as CardFields["type"])}>
              {CARD_TYPES.map((type) => (
                <option key={type} value={type}>{t(`board.type.${type}`)}</option>
              ))}
            </select>
          </label>
          <label className="board-field">
            <span>{t("board.fieldPriority")}</span>
            <select
              aria-label={t("board.fieldPriority")}
              value={fields.priority}
              onChange={(e) => set("priority", e.target.value as CardFields["priority"])}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{t(`board.priority.${p}`)}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="board-field">
          <span>{t("board.fieldDescription")}</span>
          <textarea
            aria-label={t("board.fieldDescription")}
            rows={5}
            value={fields.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <div className="board-field">
          <span>{t("board.fieldTags")}</span>
          <div className="board-tags">
            {fields.tags.map((tag) => (
              <button key={tag} type="button" className="board-tag" onClick={() => set("tags", fields.tags.filter((x) => x !== tag))}>
                #{tag} ×
              </button>
            ))}
          </div>
          <input
            aria-label={t("board.fieldTags")}
            value={tagDraft}
            placeholder={t("board.tagHint")}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
          />
        </div>
        {error && <div className="board-error" role="alert">{error}</div>}
        <div className="board-details-actions">
          <button type="button" className="vlx-btn vlx-btn-primary" disabled={busy || !fields.title.trim()} onClick={() => void save()}>
            {t("board.save")}
          </button>
          {number !== undefined && (
            <button
              type="button"
              className="vlx-btn board-delete"
              disabled={busy}
              onClick={() => (confirmDelete ? void run(() => boardCardDelete(projectId, number), onClose) : setConfirmDelete(true))}
            >
              {confirmDelete ? t("board.deleteConfirm") : t("board.delete")}
            </button>
          )}
        </div>
        {card && onSend && (
          <button
            type="button"
            className="vlx-btn board-send"
            disabled={busy}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSendMenu({ x: r.left, y: r.bottom });
            }}
          >
            <Icons.bot size={12} /> {t("board.sendToClaude")}
          </button>
        )}
        {sendMenu && card && onSend && (
          <ContextMenu
            x={sendMenu.x}
            y={sendMenu.y}
            onClose={() => setSendMenu(null)}
            items={[
              { label: t("board.newSession"), onClick: () => void run(async () => onSend(card, "new")) },
              ...(claudeSessions.length ? [{ label: "", separator: true } as MenuItem] : []),
              ...claudeSessions.map((session) => ({ label: session.name, onClick: () => void run(async () => onSend(card, session)) })),
            ]}
          />
        )}
        {card && (
          <>
            <h4>{t("board.notes")}</h4>
            <ul className="board-notes" aria-label={t("board.notes")}>
              {card.notes.map((n) => (
                <li key={n.id}>
                  <div className="board-when">{who(n.authorKind, n.authorName)} · {ago(n.createdAt)}</div>
                  <div className="board-note-text">{n.text}</div>
                </li>
              ))}
            </ul>
            <textarea aria-label={t("board.addNote")} rows={2} value={note} placeholder={t("board.addNote")} onChange={(e) => setNote(e.target.value)} />
            <button
              type="button"
              className="vlx-btn"
              disabled={busy || !note.trim()}
              onClick={() => void run(() => boardNoteAdd(projectId, card.number, note.trim()), () => { setNote(""); load(false); })}
            >
              {t("board.addNoteButton")}
            </button>
            <h4>{t("board.history")}</h4>
            <ul className="board-history" aria-label={t("board.history")}>
              {card.history.map((h) => (
                <li key={h.id}>
                  {who(h.actorKind, h.actorName)} {t(`board.action.${h.action}`)} {actionDetail(h.action, h.detail)}
                  <span className="board-when"> · {ago(h.createdAt)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
