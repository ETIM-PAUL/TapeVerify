/** Prev/next controls with a page-size picker, for lists that are paged in the browser. */
export function Pager({
  page,
  size,
  sizes,
  total,
  hasMore = false,
  busy = false,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  sizes: number[];
  /** Items loaded so far. */
  total: number;
  /** More exist beyond `total` (the next page will fetch them). */
  hasMore?: boolean;
  busy?: boolean;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  if (total <= Math.min(...sizes) && !hasMore) return null;
  const from = total === 0 ? 0 : page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  const canNext = (page + 1) * size < total || hasMore;
  return (
    <div className="pager">
      <span className="muted small">
        {from}–{to} of {total}
        {hasMore ? "+" : ""}
      </span>
      <div className="pager-ctl">
        <label className="pager-size muted small">
          Per page
          <select value={size} onChange={(e) => onSize(Number(e.target.value))}>
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost"
          disabled={page === 0 || busy}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className="ghost"
          disabled={!canNext || busy}
          onClick={() => onPage(page + 1)}
        >
          {busy ? "Loading…" : "Next"}
        </button>
      </div>
    </div>
  );
}
