import { useEffect, useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";

interface InstallPromptEvent extends Event {
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

function isInstallPromptEvent(event: Event): event is InstallPromptEvent {
  return (
    "prompt" in event &&
    typeof event.prompt === "function" &&
    "userChoice" in event &&
    event.userChoice instanceof Promise
  );
}

export function PwaManager(): React.JSX.Element | null {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(
    null,
  );
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisterError(error) {
      if (import.meta.env.DEV)
        console.error("Service worker registration failed.", error);
    },
  });

  useEffect(() => {
    const captureInstallPrompt = (event: Event): void => {
      if (!isInstallPromptEvent(event)) return;
      event.preventDefault();
      setInstallPrompt(event);
    };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    return () =>
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
  }, []);

  const showInstall = async (): Promise<void> => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  if (!needRefresh && !offlineReady && !installPrompt) return null;

  return (
    <aside className="pwa-notice" aria-live="polite" aria-label="App update">
      <div>
        <strong>
          {needRefresh
            ? "A safer, newer RafayPair is ready"
            : offlineReady
              ? "Ready for brief outages"
              : "Install RafayPair"}
        </strong>
        <p>
          {needRefresh
            ? "Update when you are ready. Your current screen will reload."
            : offlineReady
              ? "The app shell and message-free care drafts can work offline."
              : "Keep RafayPair close with a home-screen app."}
        </p>
      </div>
      <div className="pwa-notice-actions">
        {needRefresh && (
          <button
            className="button button--small"
            type="button"
            onClick={() => void updateServiceWorker(true)}
          >
            Update now
          </button>
        )}
        {installPrompt && !needRefresh && (
          <button
            className="button button--small"
            type="button"
            onClick={() => void showInstall()}
          >
            Install
          </button>
        )}
        <button
          className="text-button"
          type="button"
          onClick={() => {
            setNeedRefresh(false);
            setOfflineReady(false);
            if (!needRefresh && !offlineReady) setInstallPrompt(null);
          }}
        >
          Not now
        </button>
      </div>
    </aside>
  );
}
