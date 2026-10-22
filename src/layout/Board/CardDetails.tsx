//! Side panel of the board for one card: its fields, notes thread, history and "Send to Claude".
//! New cards are added through `AddCardDialog`.
import { useCallback, useEffect, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import Icons from "../../components/Icons";
import { useT } from "../../i18n";
import {
  boardCardDelete,
  boardCardDetail,
  boardCardUpdate,
  boardNoteAdd,
  onBoardChanged,
  type BoardCard,
  type BoardColumnInfo,
  type CardDetail,
  type CardFields,
} from "../../ipc/board";
import type { Session } from "../../types";
import { ago } from "./BoardCard";
import { CardFieldsForm, EMPTY_FIELDS } from "./CardFieldsForm";
import { columnLabelById } from "./columns";

export function CardDetails({
  projectId,
  number,
  onClose,
  columns = [],
  claudeSessions = [],
  onSend,
}: {
  projectId: string;
  number: number;
  onClose: () => void;
  /** The board's columns, to name the ones in the history. */
  columns?: BoardColumnInfo[];
  /** The project's Claude sessions offered by "Send to Claude". */
  claudeSessions?: Session[];
  onSend?: (card: BoardCard, target: "new" | Session) => Promise<void> | void;
}) {
  const t = useT();
  const [card, setCard] = useState<CardDetail | null>(null);
  const [fields, setFields] = useState<CardFields>(EMPTY_FIELDS);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sendMenu, setSendMenu] = useState<{ x: number; y: number } | null>(null);

  /** Refresh the card. The form is reset only on first load and after a save, so a change made elsewhere on
   * the board (often by a Claude session) never overwrites what the user is typing. */
  const load = useCallback((resetFields: boolean) => {
    boardCardDetail(projectId, number)
      .then((d) => {
        setCard(d);
        if (resetFields) {
          setFields({ title: d.title, type: d.type, priority: d.priority, description: d.description, tags: d.tags, color: d.color });
        }
      })
      .catch((e) => setError(String(e)));
  }, [projectId, number]);

  useEffect(() => {
    load(true);
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
  }, [projectId, load]);

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

  const save = () => run(() => boardCardUpdate(projectId, number, { ...fields, title: fields.title.trim() }), () => load(true));
  const who = (kind: "user" | "agent", name: string | null) => (kind === "user" ? t("board.byYou") : name ?? "Claude");

  return (
    <aside className="board-details" aria-label={`#${number}`}>
      <header className="board-details-head">
        <strong>#{number}</strong>
        <button type="button" className="board-card-menu" aria-label={t("common.close")} onClick={onClose}>
          <Icons.x size={13} />
        </button>
      </header>
      <div className="board-details-body">
        <label className="board-field">
          <span>{t("board.fieldTitle")}</span>
          <input aria-label={t("board.fieldTitle")} value={fields.title} onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))} />
        </label>
        <CardFieldsForm fields={fields} onChange={(key, value) => setFields((f) => ({ ...f, [key]: value }))} />
        {error && <div className="board-error" role="alert">{error}</div>}
        <div className="board-details-actions">
          <button type="button" className="vlx-btn vlx-btn-primary" disabled={busy || !fields.title.trim()} onClick={() => void save()}>
            {t("board.save")}
          </button>
          <button
            type="button"
            className="vlx-btn board-delete"
            disabled={busy}
            onClick={() => (confirmDelete ? void run(() => boardCardDelete(projectId, number), onClose) : setConfirmDelete(true))}
          >
            {confirmDelete ? t("board.deleteConfirm") : t("board.delete")}
          </button>
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
              {card.history.map((h) => {
                const detail = h.action === "moved" && h.detail ? columnLabelById(t, columns, h.detail) : h.detail;
                return (
                  <li key={h.id}>
                    {[who(h.actorKind, h.actorName), t(`board.action.${h.action}`), detail].filter(Boolean).join(" ")}
                    <span className="board-when"> · {ago(h.createdAt)}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
