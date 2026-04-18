import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-sunken flex items-center justify-center p-8">
          <div className="bg-surface rounded-xl p-8 max-w-lg w-full shadow-xl border border-danger/30">
            <h1 className="text-danger font-semibold text-lg mb-2">Something went wrong</h1>
            <p className="text-fg-tertiary text-sm mb-4">
              An unexpected error occurred. Please refresh the page.
            </p>
            <pre className="text-xs text-fg-muted bg-sunken rounded p-3 overflow-auto max-h-48">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 bg-blue-600 hover:bg-blue-700 text-fg text-sm px-4 py-2 rounded font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
