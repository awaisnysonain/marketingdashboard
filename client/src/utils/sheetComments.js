import { commentTargetKey } from './commentKeys';

/** Daily metric cell: scope|header|date */
export function dailyCellKey(scope, row, header, dateField = '_date') {
  const date = row[dateField] ?? row.Date ?? row.date;
  return commentTargetKey(scope, header, date);
}

/** Entity + date cell (e.g. channel daily rows). */
export function entityDateCellKey(scope, row, header, entityField, dateField = 'Date') {
  return commentTargetKey(scope, row[entityField], header, row[dateField]);
}

/** Aggregate row without date (e.g. channel totals). */
export function aggCellKey(scope, row, header, entityField) {
  return commentTargetKey(scope, row[entityField], header);
}

export function dailyCellLabel(header, row, dateField = '_date') {
  const date = row[dateField] ?? row.Date ?? row.date;
  return `${header} · ${date || '—'}`;
}

export function entityDateCellLabel(entity, header, row, entityField, dateField = 'Date') {
  return `${row[entityField] || entity} · ${header} · ${row[dateField] || '—'}`;
}
