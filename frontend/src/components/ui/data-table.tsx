"use client";
import { ReactNode, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { clsx } from "clsx";
import { EmptyState } from "./empty-state";
import styles from "./data-table.module.css";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  align?: "left" | "right" | "center";
  width?: string;
}

/** Sticky-header, sortable, horizontally-scrollable table for record lists. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyTitle = "No records",
  emptyDescription,
  defaultSort,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyTitle?: string;
  emptyDescription?: string;
  defaultSort?: { key: string; direction: "asc" | "desc" };
}) {
  const [sort, setSort] = useState(defaultSort);

  const sorted = useMemo(() => {
    if (!sort) {
      return rows;
    }
    const column = columns.find((col) => col.key === sort.key);
    if (!column?.sortValue) {
      return rows;
    }
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = column.sortValue!(a);
      const vb = column.sortValue!(b);
      if (va === vb) {
        return 0;
      }
      return va > vb ? factor : -factor;
    });
  }, [rows, sort, columns]);

  function toggleSort(column: DataTableColumn<T>) {
    if (!column.sortValue) {
      return;
    }
    setSort((current) => {
      if (current?.key !== column.key) {
        return { key: column.key, direction: "asc" };
      }
      return {
        key: column.key,
        direction: current.direction === "asc" ? "desc" : "asc",
      };
    });
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{
                  width: column.width,
                  textAlign: column.align ?? "left",
                }}
                className={clsx(column.sortValue && styles.sortable)}
                onClick={() => toggleSort(column)}
                aria-sort={
                  sort?.key === column.key
                    ? sort.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : undefined
                }
              >
                <span className={styles.headerLabel}>
                  {column.header}
                  {column.sortValue &&
                    (sort?.key === column.key ? (
                      sort.direction === "asc" ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      )
                    ) : (
                      <ArrowUpDown size={12} className={styles.sortIdle} />
                    ))}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{ textAlign: column.align ?? "left" }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
