import React from 'react';
import SheetTable from './SheetTable';
import TablePagination from './TablePagination';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';

/**
 * SheetTable with numbered pages (no inner scroll). KPIs/charts should use full datasets upstream.
 */
export default function PaginatedSheetTable({
  rows = [],
  pageSize = TABLE_PAGE_SIZE,
  resetDeps,
  showPagination = true,
  ...sheetProps
}) {
  const { page, setPage, pageItems, totalRows, pageSize: ps } = useClientPagination(
    rows,
    pageSize,
    resetDeps ?? [rows],
  );

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg2)' }}>
      <SheetTable rows={pageItems} scrollable={false} {...sheetProps} />
      {showPagination && (
        <TablePagination
          page={page}
          pageSize={ps}
          totalRows={totalRows}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
