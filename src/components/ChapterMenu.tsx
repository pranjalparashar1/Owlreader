import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { OutlineItem } from './readerTypes';
import { CheckIcon } from './icons';

interface Props {
  items: OutlineItem[];
  page: number;
  onPick: (page: number) => void;
  onClose: () => void;
}

/** The chapter list under the title, like an iOS pull-down menu. */
export default function ChapterMenu({ items, page, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  // the chapter you're in: the last one starting at or before this page
  let current = -1;
  items.forEach((c, i) => {
    if (c.page <= page) current = i;
  });
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0" onClick={onClose} />
      <div
        ref={ref}
        role="menu"
        aria-label="Chapters"
        className="chapter-menu no-scrollbar absolute left-1/2 overflow-y-auto overscroll-contain rounded-[18px] bg-surface py-1.5 text-fg shadow-[0_12px_40px_-8px_rgb(0_0_0/0.45)] ring-1 ring-line"
        style={{
          top: 'calc(54px + env(safe-area-inset-top) * 1.25)',
          width: 'min(320px, calc(100vw - 24px))',
          marginLeft: 'calc(min(320px, calc(100vw - 24px)) / -2)',
          maxHeight: 'min(60dvh, 520px)',
        }}
      >
        {items.map((c, i) => (
          <button
            key={`${i}-${c.page}`}
            role="menuitem"
            aria-current={i === current}
            onClick={() => onPick(c.page)}
            className="flex w-full items-center gap-2 py-2.5 pr-4 text-left text-[15px] active:bg-surface-2"
            style={{ paddingLeft: 14 + c.depth * 16 }}
          >
            <span className="w-4 shrink-0 text-accent">{i === current && <CheckIcon size={15} />}</span>
            <span className={`min-w-0 flex-1 truncate ${c.depth ? 'text-[14px]' : 'font-medium'}`}>{c.title}</span>
            <span className="shrink-0 text-[13px] text-muted tabular-nums">{c.page}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
