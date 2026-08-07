import type { PropsWithChildren } from "react";

interface InlineAlertProps extends PropsWithChildren {
  readonly tone?: "error" | "info" | "success" | "warning";
  readonly title?: string;
}

export function InlineAlert({
  tone = "info",
  title,
  children,
}: InlineAlertProps): React.JSX.Element {
  return (
    <div
      className={`inline-alert inline-alert--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function PageSpinner({
  label = "Loading",
}: {
  readonly label?: string;
}): React.JSX.Element {
  return (
    <div className="page-spinner" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  eyebrow,
  title,
  children,
}: PropsWithChildren<{
  readonly eyebrow?: string;
  readonly title: string;
}>): React.JSX.Element {
  return (
    <div className="empty-state">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2>{title}</h2>
      <div className="empty-state-copy">{children}</div>
    </div>
  );
}
