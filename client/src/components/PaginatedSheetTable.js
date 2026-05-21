import React, { useMemo, useState } from 'react';
import SheetTable from './SheetTable';
import TablePagination from './TablePagination';
import TableFilterBar from './TableFilterBar';
import { useClientPagination } from '../hooks/useClientPagination';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';
import { filterTableRows, sortTableRows } from '../utils/tableFilterSort';

/**
 * SheetTable with numbered pages (no inner scroll). Search and sort run on the
 * full row set before slicing to the current page.
 */
export default function PaginatedSheetTable({
  rows = [],
  headers = [],
  pageSize = TABLE_PAGE_SIZE,
  resetDeps,
  showPagination = true,
  searchable = true,
  defaultSortField = null,
  defaultSortDir = 'desc',
  searchPlaceholder,
  ...sheetProps
}) {
  const [search, setSearch] = useState('');
  const [searchColumn, setSearchColumn] = useState(SEARCH_ALL_COLUMNS);
  const [sortBy, setSortBy] = useState(defaultSortField || null);
  const [sortDir, setSortDir] = useState(defaultSortDir);

  const filtered = useMemo(
    () => filterTableRows(rows, headers, search, searchColumn),
    [rows, headers, search, searchColumn],
  );
  const sorted = useMemo(
    () => sortTableRows(filtered, sortBy, sortDir),
    [filtered, sortBy, sortDir],
  );

  const paginationReset = resetDeps ?? [rows, search, searchColumn, sortBy, sortDir];
  const { page, setPage, pageItems, totalRows, pageSize: ps } = useClientPagination(
    sorted,
    pageSize,
    paginationReset,
  );

  function resetFilters() {
    setPage(1);
  }

  function handleSort(field) {
    if (sortBy === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(field);
      setSortDir('asc');
    }
    setPage(1);
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg2)' }}>
      {searchable ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '10px 12px 0',
          }}
        >
          <TableFilterBar
            headers={headers}
            searchColumn={searchColumn}
            onSearchColumnChange={(col) => {
              setSearchColumn(col);
              resetFilters();
            }}
            search={search}
            onSearchChange={(v) => {
              setSearch(v);
              resetFilters();
            }}
            placeholder={searchPlaceholder}
          />
          <span style={{ fontSize: 11, color: 'var(--text4)', marginLeft: 'auto' }}>
            {sorted.length.toLocaleString()} row{sorted.length !== 1 ? 's' : ''}
            {search ? ` (filtered from ${(rows || []).length.toLocaleString()})` : ''}
          </span>
        </div>
      ) : null}
      <SheetTable
        rows={pageItems}
        headers={headers}
        scrollable={false}
        searchable={false}
        hideRowCount
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={handleSort}
        {...sheetProps}
      />
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
