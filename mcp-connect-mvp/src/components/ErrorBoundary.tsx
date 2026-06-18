/**
 * ErrorBoundary — catches render/runtime errors in its subtree and shows a
 * recoverable error panel instead of a black screen. The app previously had no
 * error boundary anywhere, so any thrown error during render unmounted the whole
 * React tree and left a blank window (see CLAUDE.md rule #1). Wrapping the main
 * view keeps a crash localized and surfaces the actual error + stack.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Re-mounts children when this value changes (e.g. on view/route change). */
  resetKey?: unknown;
  label?: string;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught render error:', error, info);
    this.setState({ info });
  }

  componentDidUpdate(prev: Props): void {
    // Auto-clear the error when the caller switches context (e.g. changes view).
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-boundary-panel">
        <div className="error-boundary-card">
          <h2>Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}.</h2>
          <p className="error-boundary-message">{error.message || String(error)}</p>
          <button className="error-boundary-retry" onClick={() => this.setState({ error: null, info: null })}>
            Try again
          </button>
          {(error.stack || info?.componentStack) && (
            <pre className="error-boundary-stack">{error.stack || info?.componentStack}</pre>
          )}
        </div>
      </div>
    );
  }
}
