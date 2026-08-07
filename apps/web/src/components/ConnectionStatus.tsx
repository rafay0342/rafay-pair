import type { RealtimeStatus } from "../domain/types";

const statusContent: Readonly<
  Record<RealtimeStatus, { readonly label: string; readonly detail: string }>
> = {
  idle: {
    label: "Not connected",
    detail: "Live updates start when your pair is active.",
  },
  connecting: {
    label: "Connecting",
    detail: "Opening a secure live connection.",
  },
  connected: {
    label: "Live",
    detail: "Care updates will arrive in real time.",
  },
  recovering: {
    label: "Reconnecting",
    detail: "Recovering any events you may have missed.",
  },
  offline: {
    label: "Offline",
    detail: "Live partner updates are unavailable until you reconnect.",
  },
};

export function ConnectionStatus({
  status,
}: {
  readonly status: RealtimeStatus;
}): React.JSX.Element {
  const content = statusContent[status];
  return (
    <span className={`connection connection--${status}`} title={content.detail}>
      <span className="connection-dot" aria-hidden="true" />
      <span>{content.label}</span>
    </span>
  );
}
