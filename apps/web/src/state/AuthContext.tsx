import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ApiError } from "../api/ApiError";
import { apiClient } from "../api/client";
import type { User } from "../domain/types";
import {
  clearOfflineCareDrafts,
  purgeOfflineCareDraftsForOtherUsers,
} from "../storage/careDrafts";

type AuthStatus = "loading" | "anonymous" | "authenticated";

interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: User | null;
  readonly login: (input: {
    readonly email: string;
    readonly password: string;
  }) => Promise<void>;
  readonly register: (input: {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({
  children,
}: PropsWithChildren): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  const prepareAuthenticatedStorage = useCallback(
    async (authenticatedUser: User): Promise<void> => {
      // A prior account's local actions must never be replayed under this
      // session. Scoped reads already fail closed; this also removes abandoned
      // records and their non-exportable encryption keys.
      await purgeOfflineCareDraftsForOtherUsers(authenticatedUser.id).catch(
        () => undefined,
      );
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();

    void apiClient
      .session(controller.signal)
      .then(async (result) => {
        await prepareAuthenticatedStorage(result.user);
        setUser(result.user);
        setStatus("authenticated");
        return undefined;
      })
      .catch(async (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return undefined;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          await clearOfflineCareDrafts().catch(() => undefined);
          setUser(null);
          setStatus("anonymous");
          return undefined;
        }
        setUser(null);
        setStatus("anonymous");
        return undefined;
      });

    return () => controller.abort();
  }, [prepareAuthenticatedStorage]);

  const login = useCallback(
    async (input: { readonly email: string; readonly password: string }) => {
      const result = await apiClient.login(input);
      await prepareAuthenticatedStorage(result.user);
      setUser(result.user);
      setStatus("authenticated");
    },
    [prepareAuthenticatedStorage],
  );

  const register = useCallback(
    async (input: {
      readonly displayName: string;
      readonly email: string;
      readonly password: string;
    }) => {
      const result = await apiClient.register(input);
      await prepareAuthenticatedStorage(result.user);
      setUser(result.user);
      setStatus("authenticated");
    },
    [prepareAuthenticatedStorage],
  );

  const logout = useCallback(async () => {
    try {
      await apiClient.logout();
    } finally {
      setUser(null);
      setStatus("anonymous");
      await clearOfflineCareDrafts().catch(() => undefined);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, register, logout }),
    [status, user, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider.");
  return value;
}
