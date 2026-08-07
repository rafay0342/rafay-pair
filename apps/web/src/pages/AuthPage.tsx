import { type FormEvent, useId, useState } from "react";

import { getErrorMessage } from "../api/ApiError";
import { Brand } from "../components/Brand";
import { InlineAlert } from "../components/Feedback";
import { useAuth } from "../state/AuthContext";

type AuthMode = "login" | "register";

export function AuthPage(): React.JSX.Element {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<AuthMode>("login");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const displayNameId = useId();
  const emailId = useId();
  const passwordId = useId();

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const emailValue = form.get("email");
    const passwordValue = form.get("password");
    const displayNameValue = form.get("displayName");
    const email = typeof emailValue === "string" ? emailValue.trim() : "";
    const password = typeof passwordValue === "string" ? passwordValue : "";
    const displayName =
      typeof displayNameValue === "string" ? displayNameValue.trim() : "";
    setError(null);
    setSubmitting(true);

    try {
      if (mode === "register") await register({ displayName, email, password });
      else await login({ email, password });
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (nextMode: AuthMode): void => {
    setMode(nextMode);
    setError(null);
  };

  return (
    <main className="auth-page">
      <section className="auth-story" aria-labelledby="auth-heading">
        <Brand />
        <div className="auth-story-content">
          <p className="eyebrow">A private space for two</p>
          <h1 id="auth-heading">Care should feel close, never intrusive.</h1>
          <p className="auth-lede">
            Send a gentle check-in, choose exactly what you share, and pause
            partner access in one tap.
          </p>
          <div className="trust-list" aria-label="Privacy commitments">
            <span>Consent before sharing</span>
            <span>No wearable required</span>
            <span>No made-up health readings</span>
          </div>
        </div>
        <p className="auth-footnote">
          RafayPair is not an emergency or medical service.
        </p>
      </section>

      <section
        className="auth-panel"
        aria-label={mode === "login" ? "Sign in" : "Create an account"}
      >
        <div className="auth-card">
          <div className="segmented-control" aria-label="Account action">
            <button
              className={mode === "login" ? "is-active" : undefined}
              type="button"
              aria-pressed={mode === "login"}
              onClick={() => switchMode("login")}
            >
              Sign in
            </button>
            <button
              className={mode === "register" ? "is-active" : undefined}
              type="button"
              aria-pressed={mode === "register"}
              onClick={() => switchMode("register")}
            >
              Create account
            </button>
          </div>

          <div className="auth-card-heading">
            <p className="eyebrow">
              {mode === "login" ? "Welcome back" : "Start with your account"}
            </p>
            <h2>
              {mode === "login"
                ? "Come back to your pair"
                : "Make care feel easier"}
            </h2>
            <p>
              {mode === "login"
                ? "Your secure session stays in protected cookies, never browser storage."
                : "You can connect with one person after your account is ready."}
            </p>
          </div>

          {error && <InlineAlert tone="error">{error}</InlineAlert>}

          <form
            className="auth-form"
            onSubmit={(event) => void handleSubmit(event)}
          >
            {mode === "register" && (
              <div className="field">
                <label htmlFor={displayNameId}>Your name</label>
                <input
                  id={displayNameId}
                  name="displayName"
                  type="text"
                  autoComplete="name"
                  minLength={2}
                  maxLength={80}
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor={emailId}>Email</label>
              <input
                id={emailId}
                name="email"
                type="email"
                autoComplete="email"
                required
                inputMode="email"
              />
            </div>
            <div className="field">
              <label htmlFor={passwordId}>Password</label>
              <input
                id={passwordId}
                name="password"
                type="password"
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                minLength={12}
                maxLength={128}
                required
                aria-describedby={
                  mode === "register" ? `${passwordId}-hint` : undefined
                }
              />
              {mode === "register" && (
                <small id={`${passwordId}-hint`}>
                  Use at least 12 characters. A password manager is recommended.
                </small>
              )}
            </div>
            <button
              className="button button--wide"
              type="submit"
              disabled={submitting}
            >
              {submitting
                ? "Please wait…"
                : mode === "login"
                  ? "Sign in securely"
                  : "Create account"}
            </button>
          </form>

          <p className="security-note">
            <span aria-hidden="true">●</span> Authentication is handled by the
            RafayPair API over an encrypted connection.
          </p>
        </div>
      </section>
    </main>
  );
}
