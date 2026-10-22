//! Column labels: a column's own name, or the translated default name of its standard role.
import type { useT } from "../../i18n";
import { COLUMN_ROLES, type BoardColumnInfo, type ColumnRole } from "../../ipc/board";

type T = ReturnType<typeof useT>;

export function columnLabel(t: T, column: BoardColumnInfo): string {
  return column.name ?? (column.role ? t(`board.column.${column.role}`) : column.id);
}

/** Label for a column id, also when the column has since been deleted (history keeps the id). */
export function columnLabelById(t: T, columns: BoardColumnInfo[], id: string): string {
  const column = columns.find((c) => c.id === id);
  if (column) return columnLabel(t, column);
  return (COLUMN_ROLES as readonly string[]).includes(id) ? t(`board.column.${id as ColumnRole}`) : id;
}
