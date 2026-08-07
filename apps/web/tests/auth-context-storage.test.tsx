import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/ApiError";
import { apiClient } from "../src/api/client";
import { AuthProvider, useAuth } from "../src/state/AuthContext";
import {
  clearOfflineCareDrafts,
  listOfflineCareDrafts,
  type OfflineCareDraftScope,
  saveOfflineCareDraft,
} from "../src/storage/careDrafts";

const formerAccountScope: OfflineCareDraftScope = {
  ownerUserId: "5ca2e98f-56ed-45d7-b90a-e1abf62f01ee",
  pairId: "cba1ca47-fdcb-4ae4-907d-80c2d74fd507",
};

function Harness(): React.JSX.Element {
  const { status } = useAuth();
  return <output>{status}</output>;
}

describe("authentication local-data boundary", () => {
  beforeEach(async () => {
    await clearOfflineCareDrafts();
  });

  it("clears queued care actions when the restored session is invalid", async () => {
    await saveOfflineCareDraft(formerAccountScope, "check_in");
    vi.spyOn(apiClient, "session").mockRejectedValue(
      new ApiError(401, {
        type: "about:blank",
        title: "Unauthenticated",
        status: 401,
        code: "AUTH_REQUIRED",
      }),
    );

    render(
      <AuthProvider>
        <Harness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    await expect(listOfflineCareDrafts(formerAccountScope)).resolves.toEqual(
      [],
    );
  });
});
