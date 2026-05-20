import { useState, useEffect, useMemo } from 'react';
import { TABLE_PAGE_SIZE } from '../constants/pagination';

/**
 * Client-side pagination over an in-memory row array.
 * Resets to page 1 when resetDeps change (e.g. filters, date range).
 */
export function useClientPagination(items, pageSize = TABLE_PAGE_SIZE, resetDeps = null) {
  const [page, setPage] = useState(1);
  const list = items || [];
  const totalRows = list.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize) || 1);
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pageItems = useMemo(
    () => list.slice((safePage - 1) * pageSize, safePage * pageSize),
    [list, safePage, pageSize],
  );

  const resetKey = resetDeps == null ? totalRows : JSON.stringify(resetDeps);
  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return {
    page: safePage,
    setPage,
    pageItems,
    totalRows,
    pageSize,
    totalPages,
    rowOffset: (safePage - 1) * pageSize,
  };
}
