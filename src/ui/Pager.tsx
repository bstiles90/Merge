// Page buttons for long lists (16 at a time, like fader banks), so nothing needs scrolling.
import { useState } from 'react';

export function usePages<T>(items: T[], per = 16, key?: string) {
  const pages = Math.max(1, Math.ceil(items.length / per));
  const [page, setPageState] = useState(() => {
    try {
      return key ? Number(localStorage.getItem(`merge.page.${key}`)) || 0 : 0;
    } catch {
      return 0;
    }
  });
  const p = Math.min(page, pages - 1);
  const setPage = (n: number) => {
    setPageState(n);
    try {
      if (key) localStorage.setItem(`merge.page.${key}`, String(n));
    } catch {
      /* storage unavailable */
    }
  };
  return { page: p, pages, setPage, slice: items.slice(p * per, p * per + per), start: p * per };
}

export function Pager({ labels, page, onPage }: { labels: string[]; page: number; onPage: (n: number) => void }) {
  if (labels.length < 2) return null;
  return (
    <div className="pager" role="tablist">
      {labels.map((l, i) => (
        <button key={i} role="tab" aria-selected={i === page} className={'pager-btn' + (i === page ? ' on' : '')} onClick={() => onPage(i)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** "1–16", "17–32" ... labels for paged ranges. */
export const rangeLabels = (n: number, per = 16, offset = 0) =>
  Array.from({ length: Math.ceil(n / per) }, (_, i) => `${offset + i * per + 1}–${offset + Math.min(n, (i + 1) * per)}`);
