import { Component, type ErrorInfo, type PropsWithChildren } from "react";

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<
  PropsWithChildren,
  ErrorBoundaryState
> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV)
      console.error("Uncaught application error", error, info);
  }

  public override render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="fatal-error">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <h1>RafayPair needs a fresh start</h1>
        <p>
          No private data was written to browser storage. Reload to reconnect
          securely.
        </p>
        <button
          className="button"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reload RafayPair
        </button>
      </main>
    );
  }
}
