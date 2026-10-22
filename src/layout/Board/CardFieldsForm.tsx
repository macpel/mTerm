//! Card fields shared by the Add card dialog and the card panel: type, priority, colour, description, tags.
//! The title stays with each caller, which decides its focus and Enter behaviour.
import { useState } from "react";
import { useT } from "../../i18n";
import { CARD_COLORS, CARD_TYPES, PRIORITIES, type CardFields } from "../../ipc/board";

export const EMPTY_FIELDS: CardFields = { title: "", type: "task", priority: "medium", description: "", tags: [], color: null };

export function CardFieldsForm({
  fields,
  onChange,
}: {
  fields: CardFields;
  onChange: <K extends keyof CardFields>(key: K, value: CardFields[K]) => void;
}) {
  const t = useT();
  const [tagDraft, setTagDraft] = useState("");
  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (tag && !fields.tags.includes(tag)) onChange("tags", [...fields.tags, tag]);
    setTagDraft("");
  };
  return (
    <>
      <div className="board-field-row">
        <label className="board-field">
          <span>{t("board.fieldType")}</span>
          <select aria-label={t("board.fieldType")} value={fields.type} onChange={(e) => onChange("type", e.target.value as CardFields["type"])}>
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
            onChange={(e) => onChange("priority", e.target.value as CardFields["priority"])}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{t(`board.priority.${p}`)}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="board-field">
        <span>{t("board.fieldColour")}</span>
        <div className="board-swatches" role="radiogroup" aria-label={t("board.fieldColour")}>
          {([null, ...CARD_COLORS] as const).map((color) => (
            <button
              key={color ?? "none"}
              type="button"
              role="radio"
              aria-checked={fields.color === color}
              aria-label={t(`board.colour.${color ?? "none"}`)}
              title={t(`board.colour.${color ?? "none"}`)}
              className={`board-swatch board-swatch-${color ?? "none"}`}
              onClick={() => onChange("color", color)}
            />
          ))}
        </div>
      </div>
      <label className="board-field">
        <span>{t("board.fieldDescription")}</span>
        <textarea
          aria-label={t("board.fieldDescription")}
          rows={4}
          value={fields.description}
          onChange={(e) => onChange("description", e.target.value)}
        />
      </label>
      <div className="board-field">
        <span>{t("board.fieldTags")}</span>
        {fields.tags.length > 0 && (
          <div className="board-tags">
            {fields.tags.map((tag) => (
              <button key={tag} type="button" className="board-tag" onClick={() => onChange("tags", fields.tags.filter((x) => x !== tag))}>
                #{tag} ×
              </button>
            ))}
          </div>
        )}
        <input
          aria-label={t("board.fieldTags")}
          value={tagDraft}
          placeholder={t("board.tagHint")}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              e.stopPropagation();
              addTag();
            }
          }}
          onBlur={addTag}
        />
      </div>
    </>
  );
}
