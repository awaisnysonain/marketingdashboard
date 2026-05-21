/**
 * Filter/sort full in-memory table rows before client pagination.
 */

export function filterTableRows(rows, headers, search) {
  const q = String(search || '').trim();
  if (!q) return rows || [];
  const lower = q.toLowerCase();
  const cols = headers?.length ? headers : Object.keys((rows || [])[0] || {});
  return (rows || []).filter((row) =>
    cols.some((h) => String(row[h] ?? '').toLowerCase().includes(lower)),
  );
}

export function filterTableRowsAllFields(rows, search) {
  const q = String(search || '').trim();
  if (!q) return rows || [];
  const lower = q.toLowerCase();
  return (rows || []).filter((row) =>
    Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(lower)),
  );
}

export function sortTableRows(rows, sortBy, sortDir = 'desc', { headers = [] } = {}) {
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
