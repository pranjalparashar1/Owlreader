import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Leaves the broken screen; defaults to dropping the book from the URL and reloading. */
  onBack?: () => void;
}

interface State {
  error: Error | null;
}

/** Catches render errors so a bad PDF or a bug shows a way out instead of a blank app. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('OwlReader crashed', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const back = () => {
      this.setState({ error: null });
      if (this.props.onBack) this.props.onBack();
      else location.replace(location.pathname + location.search);
    };
    return (
      <ErrorScreen message="OwlReader hit an unexpected problem. Your books and reading positions are safe." onBack={back} />
    );
  }
}

export function ErrorScreen({
  title = 'Something went wrong',
  message,
  onBack,
}: {
  title?: string;
  message: string;
  onBack: () => void;
}) {
  return (
    <div role="alert" className="h-dvh-safe flex flex-col items-center justify-center gap-3 bg-bg p-8 text-center text-fg">
      <h1 className="font-serif text-[21px] font-semibold">{title}</h1>
      <p className="max-w-xs text-[15px] leading-relaxed text-muted">{message}</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => location.reload()} className="rounded-full bg-surface-2 px-5 py-2.5 text-[15px] font-semibold">
          Reload
        </button>
        <button onClick={onBack} className="rounded-full bg-fg px-5 py-2.5 text-[15px] font-semibold text-bg">
          Back to Library
        </button>
      </div>
    </div>
  );
}
