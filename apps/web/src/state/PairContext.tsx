import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ApiError } from "../api/ApiError";
import { apiClient } from "../api/client";
import type {
  CareKind,
  CareRequest,
  CareResponse,
  ConsentGrant,
  OfflineCareDraft,
  Pair,
  PairMember,
  RealtimeEnvelope,
  RealtimeStatus,
} from "../domain/types";
import { RealtimeClient } from "../realtime/RealtimeClient";
import {
  canQueueCareKind,
  clearOfflineCareDrafts,
  deleteOfflineCareDraft,
  type OfflineCareDraftScope,
  listOfflineCareDrafts,
  saveOfflineCareDraft,
} from "../storage/careDrafts";
import {
  clearPrivacyPauseIntent,
  type PrivacyPauseScope,
  readPrivacyPauseIntent,
  subscribePrivacyPauseIntentChanges,
  writePrivacyPauseIntent,
} from "../storage/privacyPauseIntent";
import { useAuth } from "./AuthContext";

interface CareInput {
  readonly kind: CareKind;
  readonly message?: string;
}

interface PairContextValue {
  readonly loading: boolean;
  readonly pair: Pair | null;
  readonly partner: PairMember | null;
  readonly consents: readonly ConsentGrant[];
  readonly careRequests: readonly CareRequest[];
  readonly drafts: readonly OfflineCareDraft[];
  readonly realtimeStatus: RealtimeStatus;
  readonly privacyPaused: boolean;
  readonly partnerPrivacyPaused: boolean;
  readonly sharingBlocked: boolean;
  readonly privacyPausePending: boolean;
  readonly refresh: () => Promise<void>;
  readonly createPair: () => Promise<Pair>;
  readonly joinPair: (code: string) => Promise<void>;
  readonly disconnectPair: () => Promise<void>;
  readonly updateConsent: (
    grant: Pick<ConsentGrant, "capability" | "granted">,
  ) => Promise<void>;
  readonly sendCareRequest: (input: CareInput) => Promise<"sent" | "queued">;
  readonly respondToCareRequest: (
    id: string,
    response: CareResponse,
  ) => Promise<void>;
  readonly pausePrivacy: () => Promise<void>;
  readonly resumePrivacy: () => Promise<void>;
  readonly retryPrivacyPause: () => Promise<void>;
  readonly syncDrafts: () => Promise<void>;
  readonly discardDraft: (clientRequestId: string) => Promise<void>;
}

const PairContext = createContext<PairContextValue | undefined>(undefined);
const realtime = new RealtimeClient({ api: apiClient });

function isPrivacyBlockedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.problem?.code === "PRIVACY_PAUSED"
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function sameScope(
  left: OfflineCareDraftScope | null,
  right: OfflineCareDraftScope,
): boolean {
  return (
    left?.ownerUserId === right.ownerUserId && left.pairId === right.pairId
  );
}

function toPrivacyScope(scope: OfflineCareDraftScope): PrivacyPauseScope {
  return { userId: scope.ownerUserId, pairId: scope.pairId };
}

async function clearPrivacyPauseIntentSafely(
  scope: PrivacyPauseScope,
): Promise<void> {
  await clearPrivacyPauseIntent(scope, { notifySameDocument: false });
}

export function PairProvider({
  children,
}: PropsWithChildren): React.JSX.Element {
  const { status, user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [pair, setPair] = useState<Pair | null>(null);
  const [consents, setConsents] = useState<readonly ConsentGrant[]>([]);
  const [careRequests, setCareRequests] = useState<readonly CareRequest[]>([]);
  const [drafts, setDrafts] = useState<readonly OfflineCareDraft[]>([]);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("idle");
  const [localPrivacyPause, commitLocalPrivacyPause] = useState(false);
  const [partnerPrivacyPaused, setPartnerPrivacyPaused] = useState(false);
  const [privacyPausePending, setPrivacyPausePending] = useState(false);
  const [privacyBoundaryReady, commitPrivacyBoundaryReady] = useState(false);
  const refreshingRef = useRef<Promise<void> | undefined>(undefined);
  const refreshGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const activeScopeRef = useRef<OfflineCareDraftScope | null>(null);
  const localPrivacyPauseRef = useRef(false);
  const privacyBoundaryReadyRef = useRef(false);
  const operationControllersRef = useRef(new Set<AbortController>());
  const draftSyncRef = useRef<Promise<void> | undefined>(undefined);
  const privacyPauseSyncRef = useRef<
    | {
        readonly scope: OfflineCareDraftScope;
        readonly operation: Promise<void>;
      }
    | undefined
  >(undefined);
  const realtimeScopeRef = useRef<string | undefined>(undefined);

  const setLocalPrivacyPause = useCallback((paused: boolean): void => {
    localPrivacyPauseRef.current = paused;
    commitLocalPrivacyPause(paused);
  }, []);

  const setPrivacyBoundaryReady = useCallback((ready: boolean): void => {
    privacyBoundaryReadyRef.current = ready;
    commitPrivacyBoundaryReady(ready);
  }, []);

  const partner = useMemo<PairMember | null>(
    () => pair?.members.find((member) => member.userId !== user?.id) ?? null,
    [pair, user?.id],
  );
  const activeScope = useMemo<OfflineCareDraftScope | null>(() => {
    if (!user || pair?.status !== "active") return null;
    return { ownerUserId: user.id, pairId: pair.id };
  }, [pair?.id, pair?.status, user]);
  activeScopeRef.current = activeScope;

  const beginOperation = useCallback((): AbortController => {
    const controller = new AbortController();
    operationControllersRef.current.add(controller);
    return controller;
  }, []);

  const finishOperation = useCallback((controller: AbortController): void => {
    operationControllersRef.current.delete(controller);
  }, []);

  const isScopeActive = useCallback(
    (scope: OfflineCareDraftScope): boolean =>
      mountedRef.current && sameScope(activeScopeRef.current, scope),
    [],
  );

  useEffect(() => {
    const operationControllers = operationControllersRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
      for (const controller of operationControllers) {
        controller.abort();
      }
      operationControllers.clear();
      // React development Strict Mode remounts effects immediately. Do not let
      // an aborted first-mount operation suppress the replacement hydration.
      refreshingRef.current = undefined;
      draftSyncRef.current = undefined;
      privacyPauseSyncRef.current = undefined;
      realtime.resetRecoveryState();
      realtimeScopeRef.current = undefined;
    };
  }, []);

  const loadDraftsForScope = useCallback(
    async (scope: OfflineCareDraftScope): Promise<void> => {
      const queued = await listOfflineCareDrafts(scope);
      if (isScopeActive(scope)) setDrafts(queued);
    },
    [isScopeActive],
  );

  const refreshCare = useCallback(async (): Promise<void> => {
    const scope = activeScopeRef.current;
    if (!scope || localPrivacyPauseRef.current) return;
    const controller = beginOperation();
    try {
      const result = await apiClient.careRequests(controller.signal);
      if (!isScopeActive(scope)) return;
      setCareRequests(result.items);
      setPartnerPrivacyPaused(false);
    } catch (error) {
      if (isAbortError(error) || !isScopeActive(scope)) return;
      if (!isPrivacyBlockedError(error)) throw error;
      setCareRequests([]);
      if (!localPrivacyPauseRef.current) setPartnerPrivacyPaused(true);
    } finally {
      finishOperation(controller);
    }
  }, [beginOperation, finishOperation, isScopeActive]);

  const refresh = useCallback(async (): Promise<void> => {
    if (status !== "authenticated" || !user) return;
    if (refreshingRef.current) return refreshingRef.current;

    const generation = ++refreshGenerationRef.current;
    const controller = beginOperation();
    const previousScope = activeScopeRef.current;
    setPrivacyBoundaryReady(false);
    realtime.stop();
    setRealtimeStatus("idle");

    const refreshOperation = (async () => {
      const currentPair = await apiClient.currentPair(controller.signal);
      if (!mountedRef.current || generation !== refreshGenerationRef.current) {
        return;
      }
      setPair(currentPair);

      if (!currentPair || currentPair.status !== "active") {
        if (previousScope) {
          await Promise.allSettled([
            clearOfflineCareDrafts(previousScope),
            clearPrivacyPauseIntentSafely(toPrivacyScope(previousScope)),
          ]);
        }
        if (
          !mountedRef.current ||
          generation !== refreshGenerationRef.current
        ) {
          return;
        }
        setConsents([]);
        setCareRequests([]);
        setDrafts([]);
        setLocalPrivacyPause(false);
        setPartnerPrivacyPaused(false);
        setPrivacyPausePending(false);
        setPrivacyBoundaryReady(true);
        return;
      }

      const scope: OfflineCareDraftScope = {
        ownerUserId: user.id,
        pairId: currentPair.id,
      };
      const privacyScope = toPrivacyScope(scope);
      let storedIntent: Awaited<ReturnType<typeof readPrivacyPauseIntent>>;
      try {
        storedIntent = await readPrivacyPauseIntent(privacyScope);
      } catch {
        if (mountedRef.current && generation === refreshGenerationRef.current) {
          localPrivacyPauseRef.current = true;
          setLocalPrivacyPause(true);
          setPrivacyPausePending(true);
          setCareRequests([]);
          setPrivacyBoundaryReady(false);
        }
        throw new Error(
          "Privacy pause storage could not be verified; sharing remains blocked.",
        );
      }
      if (storedIntent) {
        setLocalPrivacyPause(true);
        setPrivacyPausePending(!storedIntent.serverConfirmed);
        setCareRequests([]);
      }

      const [privacyState, consentResult, queuedDrafts] = await Promise.all([
        apiClient.privacy(controller.signal),
        apiClient.consents(controller.signal),
        listOfflineCareDrafts(scope),
      ]);
      if (!mountedRef.current || generation !== refreshGenerationRef.current) {
        return;
      }
      setConsents(consentResult.grants);
      setDrafts(queuedDrafts);
      setPartnerPrivacyPaused(false);

      const pauseDesired = Boolean(storedIntent) || privacyState.paused;
      if (pauseDesired) {
        setLocalPrivacyPause(true);
        setCareRequests([]);
        if (privacyState.paused) {
          try {
            await writePrivacyPauseIntent(privacyScope, true, {
              notifySameDocument: false,
            });
          } catch {
            // The server is already protective. Future loads still fail closed
            // until the authoritative privacy request completes.
          }
          setPrivacyPausePending(false);
        } else {
          try {
            await writePrivacyPauseIntent(privacyScope, false, {
              notifySameDocument: false,
            });
          } catch {
            // Preserve the in-memory pause and attempt the server mutation.
          }
          setPrivacyPausePending(true);
        }
        setPrivacyBoundaryReady(true);
        return;
      }

      setLocalPrivacyPause(false);
      setPrivacyPausePending(false);
      try {
        const result = await apiClient.careRequests(controller.signal);
        if (
          !mountedRef.current ||
          generation !== refreshGenerationRef.current
        ) {
          return;
        }
        setCareRequests(result.items);
      } catch (error) {
        if (!isPrivacyBlockedError(error)) throw error;
        setCareRequests([]);
        setPartnerPrivacyPaused(true);
      }
      setPrivacyBoundaryReady(true);
    })()
      .catch((error: unknown) => {
        if (!isAbortError(error)) throw error;
      })
      .finally(() => {
        finishOperation(controller);
        if (refreshingRef.current === refreshOperation) {
          refreshingRef.current = undefined;
        }
      });

    refreshingRef.current = refreshOperation;
    return refreshOperation;
  }, [
    beginOperation,
    finishOperation,
    setLocalPrivacyPause,
    setPrivacyBoundaryReady,
    status,
    user,
  ]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void refresh()
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    const scopeIdentifier = activeScope
      ? `${activeScope.ownerUserId}:${activeScope.pairId}`
      : undefined;
    if (scopeIdentifier !== realtimeScopeRef.current) {
      realtime.resetRecoveryState();
      realtimeScopeRef.current = scopeIdentifier;
    }
  }, [activeScope]);

  useEffect(() => {
    if (
      status !== "authenticated" ||
      !activeScope ||
      !partner ||
      !privacyBoundaryReady ||
      localPrivacyPause ||
      privacyPausePending ||
      partnerPrivacyPaused
    ) {
      realtime.stop();
      setRealtimeStatus("idle");
      return undefined;
    }

    const unsubscribeStatus = realtime.subscribeStatus((snapshot) =>
      setRealtimeStatus(snapshot.status),
    );
    const unsubscribeEvents = realtime.subscribe((event: RealtimeEnvelope) => {
      if (event.type === "pair.disconnected") {
        void Promise.allSettled([
          clearOfflineCareDrafts(activeScope),
          clearPrivacyPauseIntentSafely(toPrivacyScope(activeScope)),
        ]).then(() => refresh().catch(() => undefined));
        return;
      }

      if (
        event.type === "care.request.created" ||
        event.type === "care.request.responded"
      ) {
        void refreshCare().catch(() => undefined);
        return;
      }

      if (event.type === "privacy.paused" || event.type === "privacy.resumed") {
        const eventUserId =
          typeof event.payload.userId === "string"
            ? event.payload.userId
            : undefined;
        const paused = event.type === "privacy.paused";
        if (eventUserId === user?.id) {
          if (paused) {
            realtime.stop();
            setRealtimeStatus("idle");
            localPrivacyPauseRef.current = true;
            setLocalPrivacyPause(true);
            setPrivacyPausePending(true);
            setCareRequests([]);
            void writePrivacyPauseIntent(toPrivacyScope(activeScope), true, {
              notifySameDocument: false,
            })
              .then(() => {
                if (isScopeActive(activeScope)) {
                  setPrivacyPausePending(false);
                }
                return undefined;
              })
              .catch(() => {
                if (isScopeActive(activeScope)) {
                  setPrivacyBoundaryReady(false);
                  setPrivacyPausePending(true);
                }
              });
          } else {
            setPrivacyBoundaryReady(false);
            realtime.stop();
            setRealtimeStatus("idle");
            void readPrivacyPauseIntent(toPrivacyScope(activeScope))
              .then((localIntent) => {
                if (!isScopeActive(activeScope)) return undefined;
                if (localIntent) {
                  localPrivacyPauseRef.current = true;
                  setLocalPrivacyPause(true);
                  setPrivacyPausePending(true);
                  setCareRequests([]);
                  setPrivacyBoundaryReady(true);
                  return undefined;
                }
                localPrivacyPauseRef.current = false;
                setLocalPrivacyPause(false);
                setPrivacyPausePending(false);
                void refresh().catch(() => undefined);
                return undefined;
              })
              .catch(() => {
                if (!isScopeActive(activeScope)) return;
                localPrivacyPauseRef.current = true;
                setLocalPrivacyPause(true);
                setPrivacyPausePending(true);
                setCareRequests([]);
                setPrivacyBoundaryReady(false);
              });
          }
        } else {
          setPartnerPrivacyPaused(paused);
          if (!paused) void refreshCare().catch(() => undefined);
        }
      }
    });
    realtime.start();

    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
      realtime.stop();
    };
  }, [
    status,
    activeScope,
    partner,
    user?.id,
    privacyBoundaryReady,
    localPrivacyPause,
    privacyPausePending,
    partnerPrivacyPaused,
    refresh,
    refreshCare,
    isScopeActive,
    setLocalPrivacyPause,
    setPrivacyBoundaryReady,
  ]);

  useEffect(() => {
    const handleVisibility = (): void => {
      if (
        document.visibilityState === "visible" &&
        status === "authenticated"
      ) {
        void refresh().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [status, refresh]);

  useEffect(() => {
    if (!activeScope) return undefined;
    const privacyScope = toPrivacyScope(activeScope);
    let reconciliationGeneration = 0;
    const handleChange = (): void => {
      const generation = ++reconciliationGeneration;
      setPrivacyBoundaryReady(false);
      realtime.stop();
      setRealtimeStatus("idle");
      void readPrivacyPauseIntent(privacyScope)
        .then((intent) => {
          if (
            generation !== reconciliationGeneration ||
            !isScopeActive(activeScope)
          ) {
            return undefined;
          }
          if (intent) {
            localPrivacyPauseRef.current = true;
            setLocalPrivacyPause(true);
            setPrivacyPausePending(!intent.serverConfirmed);
            setCareRequests([]);
            setPrivacyBoundaryReady(true);
            return undefined;
          }
          void refresh().catch(() => undefined);
          return undefined;
        })
        .catch(() => {
          if (
            generation !== reconciliationGeneration ||
            !isScopeActive(activeScope)
          ) {
            return;
          }
          localPrivacyPauseRef.current = true;
          setLocalPrivacyPause(true);
          setPrivacyPausePending(true);
          setCareRequests([]);
          setPrivacyBoundaryReady(false);
        });
    };
    const unsubscribe = subscribePrivacyPauseIntentChanges(handleChange);
    return () => {
      reconciliationGeneration += 1;
      unsubscribe();
    };
  }, [
    activeScope,
    isScopeActive,
    refresh,
    setLocalPrivacyPause,
    setPrivacyBoundaryReady,
  ]);

  const createPair = useCallback(async (): Promise<Pair> => {
    const created = await apiClient.createPair();
    setPair(created);
    setConsents([]);
    setCareRequests([]);
    setDrafts([]);
    setLocalPrivacyPause(false);
    setPartnerPrivacyPaused(false);
    setPrivacyPausePending(false);
    setPrivacyBoundaryReady(true);
    return created;
  }, [setLocalPrivacyPause, setPrivacyBoundaryReady]);

  const joinPair = useCallback(
    async (code: string): Promise<void> => {
      setPrivacyBoundaryReady(false);
      realtime.stop();
      setRealtimeStatus("idle");
      setPair(await apiClient.joinPair(code.trim().toUpperCase()));
      await refresh();
    },
    [refresh, setPrivacyBoundaryReady],
  );

  const disconnectPair = useCallback(async (): Promise<void> => {
    const scope = activeScopeRef.current;
    await apiClient.disconnectPair();
    realtime.resetRecoveryState();
    realtimeScopeRef.current = undefined;
    if (scope) {
      await Promise.allSettled([
        clearOfflineCareDrafts(scope),
        clearPrivacyPauseIntentSafely(toPrivacyScope(scope)),
      ]);
    }
    setPair(null);
    setConsents([]);
    setCareRequests([]);
    setDrafts([]);
    setLocalPrivacyPause(false);
    setPartnerPrivacyPaused(false);
    setPrivacyPausePending(false);
    setPrivacyBoundaryReady(true);
  }, [setLocalPrivacyPause, setPrivacyBoundaryReady]);

  const updateConsent = useCallback(
    async (grant: Pick<ConsentGrant, "capability" | "granted">) => {
      const grants: {
        capability: ConsentGrant["capability"];
        granted: boolean;
      }[] = consents.map((current) => ({
        capability: current.capability,
        granted:
          current.capability === grant.capability
            ? grant.granted
            : current.granted,
      }));
      if (!grants.some((current) => current.capability === grant.capability)) {
        grants.push({ capability: grant.capability, granted: grant.granted });
      }
      setConsents((await apiClient.updateConsents(grants)).grants);
    },
    [consents],
  );

  const sendCareRequest = useCallback(
    async (input: CareInput): Promise<"sent" | "queued"> => {
      const scope = activeScopeRef.current;
      if (!scope || !privacyBoundaryReadyRef.current) {
        throw new Error(
          "Pair and privacy state must be verified before sending.",
        );
      }
      if (
        localPrivacyPauseRef.current ||
        privacyPausePending ||
        partnerPrivacyPaused
      ) {
        throw new Error("Care sharing is paused.");
      }

      const message = input.message?.trim();
      const canQueue = !message && canQueueCareKind(input.kind);
      if (!navigator.onLine) {
        if (!canQueue) {
          throw new Error(
            "This request needs a connection because it contains private detail.",
          );
        }
        await saveOfflineCareDraft(scope, input.kind);
        await loadDraftsForScope(scope);
        return "queued";
      }

      const controller = beginOperation();
      try {
        const request = await apiClient.sendCareRequest(
          {
            clientRequestId: crypto.randomUUID(),
            kind: input.kind,
            ...(message ? { message } : {}),
          },
          controller.signal,
        );
        if (isScopeActive(scope)) {
          setCareRequests((current) => [
            request,
            ...current.filter((item) => item.id !== request.id),
          ]);
        }
        return "sent";
      } catch (error) {
        if (
          !isAbortError(error) &&
          error instanceof ApiError &&
          error.status === 0 &&
          canQueue &&
          isScopeActive(scope)
        ) {
          await saveOfflineCareDraft(scope, input.kind);
          await loadDraftsForScope(scope);
          return "queued";
        }
        throw error;
      } finally {
        finishOperation(controller);
      }
    },
    [
      beginOperation,
      finishOperation,
      isScopeActive,
      loadDraftsForScope,
      partnerPrivacyPaused,
      privacyPausePending,
    ],
  );

  const respondToCareRequest = useCallback(
    async (id: string, response: CareResponse) => {
      if (
        !privacyBoundaryReadyRef.current ||
        localPrivacyPauseRef.current ||
        privacyPausePending ||
        partnerPrivacyPaused
      ) {
        throw new Error("Care sharing is paused.");
      }
      const updated = await apiClient.respondToCareRequest(id, response);
      setCareRequests((current) =>
        current.map((item) => (item.id === id ? updated : item)),
      );
    },
    [partnerPrivacyPaused, privacyPausePending],
  );

  const synchronizePrivacyPause = useCallback(
    async (scope: OfflineCareDraftScope): Promise<void> => {
      const existing = privacyPauseSyncRef.current;
      if (existing && sameScope(existing.scope, scope)) {
        return existing.operation;
      }
      const controller = beginOperation();
      const operation = (async () => {
        try {
          const updated = await apiClient.pausePrivacy(controller.signal);
          if (!isScopeActive(scope)) return;
          if (!updated.paused) {
            throw new Error("The server did not confirm privacy pause.");
          }
          try {
            await writePrivacyPauseIntent(toPrivacyScope(scope), true, {
              notifySameDocument: false,
            });
          } catch {
            // Authoritative server pause is confirmed. Hydration remains fail closed.
          }
          localPrivacyPauseRef.current = true;
          setLocalPrivacyPause(true);
          setPrivacyPausePending(false);
          setCareRequests([]);
        } finally {
          finishOperation(controller);
        }
      })().finally(() => {
        if (privacyPauseSyncRef.current?.operation === operation) {
          privacyPauseSyncRef.current = undefined;
        }
      });
      privacyPauseSyncRef.current = { scope, operation };
      return operation;
    },
    [beginOperation, finishOperation, isScopeActive, setLocalPrivacyPause],
  );

  const pausePrivacy = useCallback(async (): Promise<void> => {
    const scope = activeScopeRef.current;
    if (!scope || !privacyBoundaryReadyRef.current) {
      throw new Error(
        "Pair and privacy state must be verified before pausing.",
      );
    }
    localPrivacyPauseRef.current = true;
    setLocalPrivacyPause(true);
    setPrivacyPausePending(true);
    setCareRequests([]);
    realtime.stop();
    setRealtimeStatus("idle");
    let persistenceError: unknown;
    try {
      await writePrivacyPauseIntent(toPrivacyScope(scope), false, {
        notifySameDocument: false,
      });
    } catch (error) {
      persistenceError = error;
    }
    try {
      await synchronizePrivacyPause(scope);
    } catch (error) {
      if (isScopeActive(scope)) setPrivacyPausePending(true);
      throw persistenceError ?? error;
    }
  }, [isScopeActive, setLocalPrivacyPause, synchronizePrivacyPause]);

  const retryPrivacyPause = useCallback(async (): Promise<void> => {
    const scope = activeScopeRef.current;
    if (!scope) throw new Error("An active pair is required to retry pause.");
    localPrivacyPauseRef.current = true;
    setLocalPrivacyPause(true);
    setPrivacyPausePending(true);
    setCareRequests([]);
    realtime.stop();
    setRealtimeStatus("idle");
    let persistenceError: unknown;
    try {
      await writePrivacyPauseIntent(toPrivacyScope(scope), false, {
        notifySameDocument: false,
      });
    } catch (error) {
      persistenceError = error;
    }
    try {
      await synchronizePrivacyPause(scope);
    } catch (error) {
      if (isScopeActive(scope)) setPrivacyPausePending(true);
      throw persistenceError ?? error;
    }
  }, [isScopeActive, setLocalPrivacyPause, synchronizePrivacyPause]);

  const resumePrivacy = useCallback(async (): Promise<void> => {
    const scope = activeScopeRef.current;
    if (!scope || !privacyBoundaryReadyRef.current) {
      throw new Error(
        "Pair and privacy state must be verified before resuming.",
      );
    }
    const privacyScope = toPrivacyScope(scope);
    const controller = beginOperation();
    try {
      const updated = await apiClient.resumePrivacy(controller.signal);
      if (!isScopeActive(scope)) return;
      if (updated.paused) {
        throw new Error("The server did not confirm privacy resume.");
      }
      // Keep the durable pause through the network round trip. Removing it only
      // after server confirmation also makes other tabs remain fail closed.
      await clearPrivacyPauseIntent(privacyScope, {
        notifySameDocument: false,
      });
      localPrivacyPauseRef.current = false;
      setLocalPrivacyPause(false);
      setPrivacyPausePending(false);
      setPartnerPrivacyPaused(false);
      await refreshCare();
    } catch (error) {
      if (isScopeActive(scope)) {
        try {
          await writePrivacyPauseIntent(privacyScope, true, {
            notifySameDocument: false,
          });
        } catch {
          // Keep the in-memory boundary even if persistence is unavailable.
        }
        setLocalPrivacyPause(true);
      }
      throw error;
    } finally {
      finishOperation(controller);
    }
  }, [
    beginOperation,
    finishOperation,
    isScopeActive,
    refreshCare,
    setLocalPrivacyPause,
  ]);

  const syncDrafts = useCallback(async (): Promise<void> => {
    if (draftSyncRef.current) return draftSyncRef.current;
    const scope = activeScopeRef.current;
    if (
      !scope ||
      !navigator.onLine ||
      !privacyBoundaryReadyRef.current ||
      localPrivacyPauseRef.current ||
      privacyPausePending ||
      partnerPrivacyPaused
    ) {
      return;
    }

    const controller = beginOperation();
    const operation = (async () => {
      const [currentPair, privacyState, queuedDrafts] = await Promise.all([
        apiClient.currentPair(controller.signal),
        apiClient.privacy(controller.signal),
        listOfflineCareDrafts(scope),
      ]);
      if (
        !isScopeActive(scope) ||
        !privacyBoundaryReadyRef.current ||
        localPrivacyPauseRef.current ||
        !currentPair ||
        currentPair.status !== "active" ||
        currentPair.id !== scope.pairId ||
        privacyState.paused
      ) {
        return;
      }

      for (const draft of queuedDrafts) {
        if (
          !isScopeActive(scope) ||
          controller.signal.aborted ||
          !privacyBoundaryReadyRef.current ||
          localPrivacyPauseRef.current
        ) {
          return;
        }
        // The API atomically revalidates the current pair, recipient consent,
        // and both privacy states. The persisted id provides idempotency.
        await apiClient.sendCareRequest(
          {
            clientRequestId: draft.clientRequestId,
            kind: draft.kind,
          },
          controller.signal,
        );
        if (
          !isScopeActive(scope) ||
          !privacyBoundaryReadyRef.current ||
          localPrivacyPauseRef.current
        ) {
          return;
        }
        await deleteOfflineCareDraft(scope, draft.clientRequestId);
      }

      if (
        !isScopeActive(scope) ||
        !privacyBoundaryReadyRef.current ||
        localPrivacyPauseRef.current
      ) {
        return;
      }
      await refreshCare();
      await loadDraftsForScope(scope);
    })().finally(() => {
      finishOperation(controller);
      if (draftSyncRef.current === operation) {
        draftSyncRef.current = undefined;
      }
    });
    draftSyncRef.current = operation;
    return operation;
  }, [
    beginOperation,
    finishOperation,
    isScopeActive,
    loadDraftsForScope,
    partnerPrivacyPaused,
    privacyPausePending,
    refreshCare,
  ]);

  useEffect(() => {
    if (status !== "authenticated" || !activeScope || !privacyBoundaryReady) {
      return undefined;
    }
    const handleOnline = (): void => {
      if (privacyPausePending) {
        void retryPrivacyPause().catch(() => undefined);
        return;
      }
      if (!localPrivacyPause && !partnerPrivacyPaused) {
        void syncDrafts().catch(() => undefined);
      }
    };
    window.addEventListener("online", handleOnline);
    if (navigator.onLine) handleOnline();
    return () => window.removeEventListener("online", handleOnline);
  }, [
    status,
    activeScope,
    privacyBoundaryReady,
    privacyPausePending,
    localPrivacyPause,
    partnerPrivacyPaused,
    retryPrivacyPause,
    syncDrafts,
  ]);

  const discardDraft = useCallback(
    async (clientRequestId: string): Promise<void> => {
      const scope = activeScopeRef.current;
      if (!scope) return;
      await deleteOfflineCareDraft(scope, clientRequestId);
      await loadDraftsForScope(scope);
    },
    [loadDraftsForScope],
  );

  const value = useMemo<PairContextValue>(
    () => ({
      loading,
      pair,
      partner,
      consents,
      careRequests,
      drafts,
      realtimeStatus,
      privacyPaused: localPrivacyPause,
      partnerPrivacyPaused,
      sharingBlocked:
        !privacyBoundaryReady ||
        localPrivacyPause ||
        privacyPausePending ||
        partnerPrivacyPaused,
      privacyPausePending,
      refresh,
      createPair,
      joinPair,
      disconnectPair,
      updateConsent,
      sendCareRequest,
      respondToCareRequest,
      pausePrivacy,
      resumePrivacy,
      retryPrivacyPause,
      syncDrafts,
      discardDraft,
    }),
    [
      loading,
      pair,
      partner,
      consents,
      careRequests,
      drafts,
      realtimeStatus,
      localPrivacyPause,
      partnerPrivacyPaused,
      privacyBoundaryReady,
      privacyPausePending,
      refresh,
      createPair,
      joinPair,
      disconnectPair,
      updateConsent,
      sendCareRequest,
      respondToCareRequest,
      pausePrivacy,
      resumePrivacy,
      retryPrivacyPause,
      syncDrafts,
      discardDraft,
    ],
  );

  return <PairContext.Provider value={value}>{children}</PairContext.Provider>;
}

export function usePair(): PairContextValue {
  const value = useContext(PairContext);
  if (!value) throw new Error("usePair must be used within PairProvider.");
  return value;
}
