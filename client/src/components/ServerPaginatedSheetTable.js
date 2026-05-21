import React from 'react';
import SheetTable from './SheetTable';
import TablePagination from './TablePagination';
import TableSearchBar from './TableSearchBar';
import { TABLE_PAGE_SIZE } from '../constants/pagination';

/**
 * Sheet table backed by server pagination. Search is sent to the API by the parent;
 * this component only renders the search input and current page rows.
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
  loading = false,
  title,
  defaultSortField = null,
  defaultSortDir = 'desc',
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
        <TableSearchBar
          value={search}
          onChange={onSearchChange}
          placeholder="Search campaigns, ad sets, ads…"
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
        defaultSortField={defaultSortField}
        defaultSortDir={defaultSortDir}
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
