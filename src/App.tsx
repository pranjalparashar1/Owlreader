import { useEffect, useRef, useState } from 'react';
import { isSupportedBook, type BookRecord } from './types';
import { getBook } from './db/libraryDb';
import { useSettings } from './lib/settings';
import LibraryView from './components/LibraryView';
import ReaderShell from './components/ReaderShell';
import ErrorBoundary from './components/ErrorBoundary';

const bookIdFromHash = () => /^#\/book\/(.+)$/.exec(location.hash)?.[1] ?? null;

export default function App() {
  const [settings, updateSettings] = useSettings();
  const [bookId, setBookId] = useState<string | null>(bookIdFromHash);
  const [book, setBook] = useState<BookRecord | null>(null);
  const pushedFromLibrary = useRef(false);

  useEffect(() => {
    const onHash = () => setBookId(bookIdFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!bookId) return setBook(null);
    let alive = true;
    // always re-read so we open at the latest saved position
    getBook(bookId).then((b) => {
      if (!alive) return;
      if (b && isSupportedBook(b)) setBook(b);
      else {
        // unknown id, or a book from an older version this one can't open
        history.replaceState(null, '', location.pathname);
        setBookId(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [bookId]);

  const open = (b: BookRecord) => {
    pushedFromLibrary.current = true;
    location.hash = `/book/${b.id}`;
  };
  const back = () => {
    if (pushedFromLibrary.current) {
      pushedFromLibrary.current = false;
      history.back();
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      setBookId(null);
    }
  };

  if (bookId && book?.id === bookId) {
    return (
      <ErrorBoundary key={book.id} onBack={back}>
        <ReaderShell book={book} settings={settings} onSettings={updateSettings} onBack={back} />
      </ErrorBoundary>
    );
  }
  if (bookId) return <div className="h-dvh-safe bg-bg" />;
  return <LibraryView onOpen={open} />;
}
