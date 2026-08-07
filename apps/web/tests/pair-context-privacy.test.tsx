import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/api/client";
import type { Pair, PrivacyState, User } from "../src/domain/types";
import { RealtimeClient } from "../src/realtime/RealtimeClient";
import { PairProvider, usePair } from "../src/state/PairContext";
import {
  clearOfflineCareDrafts,
  saveOfflineCareDraft,
} from "../src/storage/careDrafts";
import {
  clearPrivacyPauseIntent,
  readPrivacyPauseIntent,
  writePrivacyPauseIntent,
} from "../src/storage/privacyPauseIntent";

const currentUser: User = {
  id: "5ca2e98f-56ed-45d7-b90a-e1abf62f01ee",
  email: "first@example.test",
  displayName: "First",
  createdAt: "2026-08-07T00:00:00.000Z",
};
const partnerId = "47fc05cb-50f8-4487-bf9f-6b19cc5c8e1e";
const activePair: Pair = {
  id: "cba1ca47-fdcb-4ae4-907d-80c2d74fd507",
  status: "active",
  members: [
    {
      userId: currentUser.id,
      displayName: currentUser.displayName,
      joinedAt: "2026-08-07T00:00:00.000Z",
    },
    {
      userId: partnerId,
      displayName: "Partner",
      joinedAt: "2026-08-07T00:00:01.000Z",
    },
  ],
  createdAt: "2026-08-07T00:00:00.000Z",
};
const privacyScope = { userId: currentUser.id, pairId: activePair.id };
const startRealtime = vi.fn();
const stopRealtime = vi.fn();
const currentPairRequest = vi.fn();
const privacyRequest = vi.fn();
const careRequestsRequest = vi.fn();

vi.mock("../src/state/AuthContext", () => ({
  useAuth: () => ({ status: "authenticated", user: currentUser }),
}));

function privacyState(paused: boolean): PrivacyState {
  return {
    pairId: activePair.id,
    userId: currentUser.id,
    paused,
    ...(paused ? { pausedAt: "2026-08-07T00:00:02.000Z" } : {}),
    updatedAt: "2026-08-07T00:00:02.000Z",
  };
}

function Harness(): React.JSX.Element {
  const pair = usePair();
  return (
    <>
      <output data-testid="state">
        {JSON.stringify({
          loading: pair.loading,
          paused: pair.privacyPaused,
          pending: pair.privacyPausePending,
          blocked: pair.sharingBlocked,
        })}
      </output>
      <button
        type="button"
        onClick={() => void pair.pausePrivacy().catch(() => undefined)}
      >
        Pause
      </button>
      <button
        type="button"
        onClick={() => void pair.resumePrivacy().catch(() => undefined)}
      >
        Resume
      </button>
    </>
  );
}

function renderProvider(): void {
  render(
    <PairProvider>
      <Harness />
    </PairProvider>,
  );
}

async function expectState(expected: {
  readonly loading: boolean;
  readonly paused: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
}): Promise<void> {
  await waitFor(() =>
    expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toEqual(
      expected,
    ),
  );
}

describe("PairProvider privacy boundary", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearOfflineCareDrafts();
    await clearPrivacyPauseIntent(privacyScope);
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    vi.spyOn(apiClient, "currentPair").mockImplementation(async () => {
      currentPairRequest();
      return activePair;
    });
    vi.spyOn(apiClient, "privacy").mockImplementation(async () => {
      privacyRequest();
      return privacyState(false);
    });
    vi.spyOn(apiClient, "consents").mockResolvedValue({
      pairId: activePair.id,
      grantorUserId: currentUser.id,
      granteeUserId: partnerId,
      grants: [],
    });
    vi.spyOn(apiClient, "careRequests").mockImplementation(async () => {
      careRequestsRequest();
      return { items: [] };
    });
    vi.spyOn(RealtimeClient.prototype, "start").mockImplementation(() => {
      startRealtime();
    });
    vi.spyOn(RealtimeClient.prototype, "stop").mockImplementation(() => {
      stopRealtime();
    });
    vi.spyOn(RealtimeClient.prototype, "resetRecoveryState").mockImplementation(
      () => undefined,
    );
  });

  it("restores a failed pause after reload and never opens realtime", async () => {
    await writePrivacyPauseIntent(privacyScope, false);
    const pause = vi
      .spyOn(apiClient, "pausePrivacy")
      .mockRejectedValue(new Error("offline"));

    renderProvider();

    await expectState({
      loading: false,
      paused: true,
      pending: true,
      blocked: true,
    });
    await waitFor(() => expect(pause).toHaveBeenCalledOnce());
    expect(startRealtime).not.toHaveBeenCalled();
    await expect(readPrivacyPauseIntent(privacyScope)).resolves.toMatchObject({
      serverConfirmed: false,
    });
  });

  it("retries a durable pause on reconnect while sharing remains blocked", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await writePrivacyPauseIntent(privacyScope, false);
    const pause = vi
      .spyOn(apiClient, "pausePrivacy")
      .mockResolvedValue(privacyState(true));

    renderProvider();
    await expectState({
      loading: false,
      paused: true,
      pending: true,
      blocked: true,
    });
    expect(pause).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();

    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    fireEvent.online(window);

    await expectState({
      loading: false,
      paused: true,
      pending: false,
      blocked: true,
    });
    expect(pause).toHaveBeenCalledOnce();
    await expect(readPrivacyPauseIntent(privacyScope)).resolves.toMatchObject({
      serverConfirmed: true,
    });
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it("stops realtime and persists intent before awaiting the server", async () => {
    let confirmPause: ((state: PrivacyState) => void) | undefined;
    const pendingPause = new Promise<PrivacyState>((resolve) => {
      confirmPause = resolve;
    });
    const pause = vi
      .spyOn(apiClient, "pausePrivacy")
      .mockReturnValue(pendingPause);

    renderProvider();
    await expectState({
      loading: false,
      paused: false,
      pending: false,
      blocked: false,
    });
    expect(startRealtime).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await expectState({
      loading: false,
      paused: true,
      pending: true,
      blocked: true,
    });
    await waitFor(() => expect(pause).toHaveBeenCalledOnce());
    await expect(readPrivacyPauseIntent(privacyScope)).resolves.toMatchObject({
      serverConfirmed: false,
    });
    expect(stopRealtime).toHaveBeenCalled();

    confirmPause?.(privacyState(true));
    await expectState({
      loading: false,
      paused: true,
      pending: false,
      blocked: true,
    });
    await expect(readPrivacyPauseIntent(privacyScope)).resolves.toMatchObject({
      serverConfirmed: true,
    });
  });

  it("reconciles a same-document pause notification without opening sharing", async () => {
    const pause = vi
      .spyOn(apiClient, "pausePrivacy")
      .mockRejectedValue(new Error("offline"));
    renderProvider();
    await expectState({
      loading: false,
      paused: false,
      pending: false,
      blocked: false,
    });

    await writePrivacyPauseIntent(privacyScope, false);

    await expectState({
      loading: false,
      paused: true,
      pending: true,
      blocked: true,
    });
    await waitFor(() => expect(pause).toHaveBeenCalledOnce());
    expect(stopRealtime).toHaveBeenCalled();
  });

  it("retains the durable pause until the server confirms resume", async () => {
    await writePrivacyPauseIntent(privacyScope, true);
    vi.spyOn(apiClient, "privacy").mockResolvedValue(privacyState(true));
    let confirmResume: ((state: PrivacyState) => void) | undefined;
    const pendingResume = new Promise<PrivacyState>((resolve) => {
      confirmResume = resolve;
    });
    const resume = vi
      .spyOn(apiClient, "resumePrivacy")
      .mockReturnValue(pendingResume);

    renderProvider();
    await expectState({
      loading: false,
      paused: true,
      pending: false,
      blocked: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    await expect(readPrivacyPauseIntent(privacyScope)).resolves.toMatchObject({
      desiredState: "paused",
      serverConfirmed: true,
    });
    await expectState({
      loading: false,
      paused: true,
      pending: false,
      blocked: true,
    });

    confirmResume?.(privacyState(false));
    await expectState({
      loading: false,
      paused: false,
      pending: false,
      blocked: false,
    });
    await expect(readPrivacyPauseIntent(privacyScope)).resolves.toBeUndefined();
  });

  it("fails closed when IndexedDB cannot hydrate the privacy boundary", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("unavailable", "SecurityError");
    });

    renderProvider();

    await expectState({
      loading: false,
      paused: true,
      pending: true,
      blocked: true,
    });
    expect(privacyRequest).not.toHaveBeenCalled();
    expect(careRequestsRequest).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it("never auto-sends drafts owned by another account or pair", async () => {
    await saveOfflineCareDraft(
      {
        ownerUserId: partnerId,
        pairId: activePair.id,
      },
      "check_in",
    );
    await saveOfflineCareDraft(
      {
        ownerUserId: currentUser.id,
        pairId: "f46f16a4-a229-44ea-9410-68966146f776",
      },
      "encouragement",
    );
    const sendCareRequest = vi
      .spyOn(apiClient, "sendCareRequest")
      .mockRejectedValue(new Error("foreign draft must not be sent"));

    renderProvider();
    await expectState({
      loading: false,
      paused: false,
      pending: false,
      blocked: false,
    });
    await waitFor(() => expect(currentPairRequest).toHaveBeenCalledTimes(2));
    expect(sendCareRequest).not.toHaveBeenCalled();
  });
});
