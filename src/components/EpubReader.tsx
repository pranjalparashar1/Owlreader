import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { registerSelectionDocument } from '../hooks/useTextSelection';
import { epubCss, type FoliateView, type RelocateDetail } from '../lib/foliate';
import { tapZone, type ReaderHandle, type ReaderProps } from './readerTypes';

interface Props extends ReaderProps {
  fontPct: number;
  flow: 'paginated' | 'scrolled';
}

const EpubReader = forwardRef<ReaderHandle, Props>(function EpubReader(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(ref, () => ({
    goToFraction: (f) => void viewRef.current?.goToFraction(Math.min(Math.max(f, 0), 0.9999)),
    next: () => void viewRef.current?.goRight(),
    prev: () => void viewRef.current?.goLeft(),
  }));

  // Create the foliate view once per book. Resizes and rotations are handled by foliate's
  // own ResizeObserver, which keeps the current text range anchored (no reset to page 1).
  useEffect(() => {
    const host = hostRef.current!;
    let cancelled = false;
    let view: FoliateView | null = null;

    const turn = (dir: 'prev' | 'next') => {
      propsRef.current.onPageTurn();
      if (dir === 'prev') view?.goLeft();
      else view?.goRight();
    };

    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn('prev');
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) turn('next');
    };

    const wireDocument = (doc: Document) => {
      registerSelectionDocument(doc);
      let lastSelectionAt = 0;
      doc.addEventListener('selectionchange', () => {
        const sel = doc.getSelection();
        if (sel && !sel.isCollapsed) lastSelectionAt = Date.now();
      });
      doc.addEventListener('keydown', onKey);
      doc.addEventListener('click', (e: MouseEvent) => {
        if (e.defaultPrevented || e.button !== 0) return;
        if ((e.target as Element | null)?.closest?.('a[href]')) return;
        const sel = doc.getSelection();
        // A tap that dismisses a selection must not also turn the page.
        if ((sel && !sel.isCollapsed) || Date.now() - lastSelectionAt < 500) return;
        const frame = doc.defaultView?.frameElement as HTMLElement | null;
        const hostRect = host.getBoundingClientRect();
        const x = (frame?.getBoundingClientRect().left ?? 0) + e.clientX - hostRect.left;
        const zone = propsRef.current.flow === 'scrolled' ? 'center' : tapZone(x, hostRect.width);
        if (zone === 'center') propsRef.current.onCenterTap();
        else turn(zone);
      });
    };

    (async () => {
      try {
        await import('../vendor/foliate-js/view.js');
        if (cancelled) return;
        view = document.createElement('foliate-view') as FoliateView;
        view.style.cssText = 'display:block;width:100%;height:100%';
        viewRef.current = view;
        host.append(view);

        view.addEventListener('load', (e) => wireDocument((e as CustomEvent<{ doc: Document }>).detail.doc));
        view.addEventListener('relocate', (e) => {
          const d = (e as CustomEvent<RelocateDetail>).detail;
          const fraction = d.fraction ?? 0;
          propsRef.current.onLocation({ fraction, label: d.tocItem?.label?.trim() });
          if (d.cfi) propsRef.current.onProgressChange({ epubCfi: d.cfi, percentage: Math.round(fraction * 1000) / 10 });
        });

        const { data, fileName } = propsRef.current;
        await view.open(new File([data], fileName || 'book.epub', { type: 'application/epub+zip' }));
        if (cancelled) return;
        const r = view.renderer;
        r.setAttribute('flow', propsRef.current.flow);
        // animate swipe snaps and tap turns instead of jumping a whole page at once
        r.setAttribute('animated', '');
        r.setAttribute('margin', '44px');
        r.setAttribute('gap', '7%');
        r.setAttribute('max-inline-size', '680px');
        r.setAttribute('max-column-count', '2');
        r.setStyles?.(epubCss(propsRef.current.theme, propsRef.current.fontPct));
        await view.init({ lastLocation: propsRef.current.book.progress.epubCfi, showTextStart: true });
      } catch (err) {
        console.error(err);
        if (!cancelled) propsRef.current.onError("This EPUB couldn't be opened. It may be damaged or DRM-protected.");
      }
    })();

    window.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      try {
        view?.close();
      } catch {
        /* ignore */
      }
      view?.remove();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.book.id]);

  useEffect(() => {
    viewRef.current?.renderer?.setStyles?.(epubCss(props.theme, props.fontPct));
  }, [props.theme, props.fontPct]);

  useEffect(() => {
    viewRef.current?.renderer?.setAttribute('flow', props.flow);
  }, [props.flow]);

  return <div ref={hostRef} className="h-full w-full" style={{ background: 'var(--reader-bg)' }} />;
});

export default EpubReader;
