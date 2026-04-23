import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Short label for the section shown in the fallback UI (e.g. "Board", "Analytics"). */
  section: string;
}

interface State {
  error: Error | null;
}

/**
 * Lightweight error boundary for wrapping individual UI sections.
 *
 * Unlike the root ErrorBoundary (which renders a full-page crash screen), this
 * component renders an inline fallback so the rest of the application remains
 * functional. For example, if the analytics panel throws, the board grid and
 * card detail panel continue to work.
 *
 * Source of change: Gemini Pro external codebase review (2026-04-01).
 */
export default class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.section}] Uncaught error:`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center p-8">
          <div className="bg-surface rounded-lg border border-danger/30 p-6 max-w-md w-full text-center">
            <h2 className="text-danger font-semibold text-sm mb-1">
              {this.props.section} failed to load
            </h2>
            <p className="text-fg-tertiary text-xs mb-3">
              An unexpected error occurred in this section.
            </p>
            <pre className="text-xs text-fg-muted bg-sunken rounded p-2 overflow-auto max-h-24 mb-3 text-left">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="bg-button-primary hover:bg-button-primary-hover text-on-primary text-xs font-medium px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
