import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';

/**
 * Normalize a cell value for text search (dates, numbers, booleans, etc.).
 */
export function cellSearchText(value) {
  if (value == null) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Filter rows by search text. searchColumn = SEARCH_ALL_COLUMNS searches every field on the row.
 */
export function filterTableRows(rows, headers, search, searchColumn = SEARCH_ALL_COLUMNS) {
  const q = String(search || '').trim();
  if (!q) return rows || [];
  const lower = q.toLowerCase();

  if (searchColumn && searchColumn !== SEARCH_ALL_COLUMNS) {
    return (rows || []).filter((row) =>
      cellSearchText(row[searchColumn]).toLowerCase().includes(lower),
    );
  }

  const headerList = headers?.length ? headers : [];
  return (rows || []).filter((row) => {
    const keys = new Set([...headerList, ...Object.keys(row || {})]);
    for (const key of keys) {
      if (String(key).startsWith('__')) continue;
      if (cellSearchText(row[key]).toLowerCase().includes(lower)) return true;
    }
    return false;
  });
}

/** @deprecated use filterTableRows with SEARCH_ALL_COLUMNS */
export function filterTableRowsAllFields(rows, search) {
  return filterTableRows(rows, [], search, SEARCH_ALL_COLUMNS);
}

export function sortTableRows(rows, sortBy, sortDir = 'desc') {
  if (!sortBy) return rows || [];
  const textColumn =
    ['brand', 'campaign', 'ad set', 'ad'].includes(String(sortBy).toLowerCase()) ||
    /(^|\s)id($|\s)/.test(String(sortBy).toLowerCase()) ||
    /date/i.test(String(sortBy));

  return [...(rows || [])].sort((a, b) => {
    const va = a[sortBy];
    const vb = b[sortBy];
    if (va == null) return 1;
    if (vb == null) return -1;
    const na = typeof va === 'number' ? va : Number(String(va).trim());
    const nb = typeof vb === 'number' ? vb : Number(String(vb).trim());
    if (!textColumn && Number.isFinite(na) && Number.isFinite(nb)) {
      return sortDir === 'asc' ? na - nb : nb - na;
    }
    return sortDir === 'asc'
      ? String(va).localeCompare(String(vb))
      : String(vb).localeCompare(String(va));
  });
}
