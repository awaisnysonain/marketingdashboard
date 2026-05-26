import React from 'react';
import SheetTable from './SheetTable';
import TablePagination from './TablePagination';
import TableFilterBar from './TableFilterBar';
import { TABLE_PAGE_SIZE } from '../constants/pagination';
import { SEARCH_ALL_COLUMNS } from '../constants/tableSearch';

/**
 * Sheet table backed by server pagination. Parent sends search + column to the API.
 */
export default function ServerPaginatedSheetTable({
  headers = [],
  rows = [],
  keyField,
  page = 1,
  pageSize = TABLE_PAGE_SIZE,
  totalRows = 0,
  onPageChange,
  search = '',
  onSearchChange,
  searchColumn = SEARCH_ALL_COLUMNS,
  onSearchColumnChange,
  loading = false,
  title,
  sortBy = null,
  sortDir = 'desc',
  onSort,
  ...sheetProps
}) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      {title ? (
        <div style={{ fontSize: 14, fontWeight: 700, padding: '20px 20px 0' }}>{title}</div>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          padding: title ? '14px 20px 0' : '14px 20px 0',
        }}
      >
        <TableFilterBar
          headers={headers}
          searchColumn={searchColumn}
          onSearchColumnChange={onSearchColumnChange}
          search={search}
          onSearchChange={onSearchChange}
        />
        <span style={{ fontSize: 11, color: 'var(--text4)', marginLeft: 'auto' }}>
          {Number(totalRows).toLocaleString()} row{totalRows !== 1 ? 's' : ''}
          {search ? ' matching' : ''}
        </span>
      </div>
      <SheetTable
        headers={headers}
        rows={rows}
        keyField={keyField}
        scrollable={false}
        searchable={false}
        hideRowCount
        sortBy={sortBy}
        sortDir={sortDir}
        onSort={onSort}
        {...sheetProps}
      />
      <TablePagination
        page={page}
        pageSize={pageSize}
        totalRows={totalRows}
        onPageChange={onPageChange}
        loading={loading}
      />
    </div>
  );
}
