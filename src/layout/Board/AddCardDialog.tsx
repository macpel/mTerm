//! "Add card" dialog, opened from a column's + Card button or its ⋯ menu; the card lands in that column.
import { useState } from "react";
import { Backdrop } from "../../components/Backdrop";
import { useT } from "../../i18n";
import { boardCardCreate, type CardFields } from "../../ipc/board";
import { CardFieldsForm, EMPTY_FIELDS } from "./CardFieldsForm";

export function AddCardDialog({
  projectId,
  column,
  columnName,
  onClose,
}: {
  projectId: string;
  column: string;
  columnName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [fields, setFields] = useState<CardFields>(EMPTY_FIELDS);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canAdd = !busy && fields.title.trim().length > 0;

  const add = async () => {
    if (!canAdd) return;
    setBusy(true);
    setError("");
    try {
      await boardCardCreate(projectId, { ...fields, title: fields.title.trim(), column });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div
        className="board-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("board.addCardMenu")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="board-dialog-head">
          <strong>{t("board.addCardMenu")}</strong>
          <span className="board-dialog-sub">{columnName}</span>
        </header>
        <div className="board-dialog-body">
          <label className="board-field">
            <span>{t("board.fieldTitle")}</span>
            <input
              aria-label={t("board.fieldTitle")}
              value={fields.title}
              autoFocus
              onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
            />
          </label>
          <CardFieldsForm fields={fields} onChange={(key, value) => setFields((f) => ({ ...f, [key]: value }))} />
          {error && <div className="board-error" role="alert">{error}</div>}
        </div>
        <footer className="board-dialog-actions">
          <button type="button" className="vlx-btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="vlx-btn vlx-btn-primary" disabled={!canAdd} onClick={() => void add()}>
            {t("board.add")}
          </button>
        </footer>
      </div>
    </Backdrop>
  );
}
