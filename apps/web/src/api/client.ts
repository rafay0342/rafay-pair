import {
  bloodPressureListResponseSchema,
  bloodPressureResponseSchema,
  aiMemoryListResponseSchema,
  aiMemoryResponseSchema,
  authResponseSchema,
  careRequestListResponseSchema,
  careRequestResponseSchema,
  consentResponseSchema,
  pairResponseSchema,
  privacyStateResponseSchema,
  problemDetailsSchema,
  realtimeTicketResponseSchema,
  realtimeWebSocketProtocols,
  togetherSessionResponseSchema,
  userSchema,
} from "@rafay-pair/api-contracts";

import { runtimeConfig } from "../config";
import type {
  BloodPressureList,
  BloodPressureReading,
  AiMemory,
  AiMemoryCategory,
  AiMemoryList,
  AuthResult,
  CareKind,
  CareRequest,
  CareRequestList,
  CareResponse,
  ConsentGrant,
  ConsentSet,
  Pair,
  PrivacyState,
  RealtimeTicket,
  TogetherActivity,
  TogetherSession,
  TogetherStateInput,
  User,
} from "../domain/types";
import { ApiError } from "./ApiError";
import { apiPaths } from "./paths";

type HttpMethod = "DELETE" | "GET" | "POST" | "PUT";

interface RequestOptions<TBody> {
  readonly method?: HttpMethod;
  readonly body?: TBody;
  readonly signal?: AbortSignal;
  readonly csrfProtected?: boolean;
  readonly csrfToken?: string;
  readonly retryAfterRefresh?: boolean;
}

interface ContractSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: unknown };
}

const CSRF_COOKIE_NAME = "rafay_csrf";
const CSRF_HEADER_NAME = "X-CSRF-Token";
const CLIENT_HEADER_NAME = "X-Rafay-Client";

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;

  const prefix = `${encodeURIComponent(name)}=`;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);

  if (!value) return undefined;

  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function resolveApiUrl(path: string): URL {
  const base = runtimeConfig.apiBaseUrl.startsWith("http")
    ? runtimeConfig.apiBaseUrl
    : new URL(runtimeConfig.apiBaseUrl, window.location.origin).toString();

  return new URL(`${base.replace(/\/$/u, "")}${path}`);
}

function parseContract<T>(schema: ContractSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  return contractMismatch();
}

function contractMismatch(): never {
  throw new ApiError(502, {
    type: "about:blank",
    title: "Unexpected service response",
    status: 502,
    detail:
      "RafayPair received a response that did not match its versioned API contract.",
    code: "contract_mismatch",
  });
}

async function readProblem(
  response: Response,
): Promise<ConstructorParameters<typeof ApiError>[1]> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;

  try {
    const value = (await response.json()) as unknown;
    const parsed = problemDetailsSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    throw new ApiError(
      response.status,
      undefined,
      "The server returned an unexpected response.",
    );
  }

  return (await response.json()) as unknown;
}

export class ApiClient {
  private refreshPromise: Promise<void> | undefined;

  public async register(input: {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }): Promise<AuthResult> {
    const csrfToken = await this.issueAnonymousCsrf();
    const response = await this.request(apiPaths.auth.register, {
      method: "POST",
      body: input,
      csrfProtected: true,
      csrfToken,
    });
    return parseContract(authResponseSchema, response);
  }

  public async login(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<AuthResult> {
    const csrfToken = await this.issueAnonymousCsrf();
    const response = await this.request(apiPaths.auth.login, {
      method: "POST",
      body: input,
      csrfProtected: true,
      csrfToken,
    });
    return parseContract(authResponseSchema, response);
  }

  public async session(signal?: AbortSignal): Promise<{ readonly user: User }> {
    const response = await this.request(apiPaths.auth.session, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    if (!response || typeof response !== "object" || !("user" in response)) {
      return contractMismatch();
    }
    return { user: parseContract(userSchema, response.user) };
  }

  public async logout(): Promise<void> {
    await this.request(apiPaths.auth.logout, {
      method: "POST",
      body: {},
      csrfProtected: true,
    });
  }

  public async currentPair(signal?: AbortSignal): Promise<Pair | null> {
    try {
      const response = await this.request(apiPaths.pair.current, {
        ...(signal ? { signal } : {}),
        retryAfterRefresh: true,
      });
      return parseContract(pairResponseSchema, response).pair;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 404 &&
        error.problem?.code === "PAIR_NOT_FOUND"
      )
        return null;
      throw error;
    }
  }

  public async createPair(): Promise<Pair> {
    const response = await this.request(apiPaths.pair.current, {
      method: "POST",
      body: {},
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(pairResponseSchema, response).pair;
  }

  public async joinPair(code: string): Promise<Pair> {
    const response = await this.request(apiPaths.pair.join, {
      method: "POST",
      body: { code },
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(pairResponseSchema, response).pair;
  }

  public async disconnectPair(): Promise<void> {
    await this.request(apiPaths.pair.current, {
      method: "DELETE",
      csrfProtected: true,
      retryAfterRefresh: true,
    });
  }

  public async consents(signal?: AbortSignal): Promise<ConsentSet> {
    const response = await this.request(apiPaths.consents, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    return parseContract(consentResponseSchema, response);
  }

  public async updateConsents(
    grants: readonly Pick<ConsentGrant, "capability" | "granted">[],
  ): Promise<ConsentSet> {
    const response = await this.request(apiPaths.consents, {
      method: "PUT",
      body: { grants },
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(consentResponseSchema, response);
  }

  public async careRequests(signal?: AbortSignal): Promise<CareRequestList> {
    const response = await this.request(apiPaths.careRequests, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    return parseContract(careRequestListResponseSchema, response);
  }

  public async sendCareRequest(
    input: {
      readonly clientRequestId: string;
      readonly kind: CareKind;
      readonly message?: string;
    },
    signal?: AbortSignal,
  ): Promise<CareRequest> {
    const response = await this.request(apiPaths.careRequests, {
      method: "POST",
      body: input,
      csrfProtected: true,
      retryAfterRefresh: true,
      ...(signal ? { signal } : {}),
    });
    return parseContract(careRequestResponseSchema, response).careRequest;
  }

  public async respondToCareRequest(
    id: string,
    careResponse: CareResponse,
  ): Promise<CareRequest> {
    const response = await this.request(apiPaths.careResponse(id), {
      method: "POST",
      body: { response: careResponse },
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(careRequestResponseSchema, response).careRequest;
  }

  public async privacy(signal?: AbortSignal): Promise<PrivacyState> {
    const response = await this.request(apiPaths.privacy.current, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    return parseContract(privacyStateResponseSchema, response).privacy;
  }

  public async pausePrivacy(signal?: AbortSignal): Promise<PrivacyState> {
    const response = await this.request(apiPaths.privacy.pause, {
      method: "POST",
      body: {},
      csrfProtected: true,
      retryAfterRefresh: true,
      ...(signal ? { signal } : {}),
    });
    return parseContract(privacyStateResponseSchema, response).privacy;
  }

  public async resumePrivacy(signal?: AbortSignal): Promise<PrivacyState> {
    const response = await this.request(apiPaths.privacy.resume, {
      method: "POST",
      body: {},
      csrfProtected: true,
      retryAfterRefresh: true,
      ...(signal ? { signal } : {}),
    });
    return parseContract(privacyStateResponseSchema, response).privacy;
  }

  // MARK: - Together mode

  public async currentTogetherSession(
    signal?: AbortSignal,
  ): Promise<TogetherSession | null> {
    const response = await this.request(apiPaths.together.current, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    return parseContract(togetherSessionResponseSchema, response).session;
  }

  public async inviteTogetherSession(
    activity: TogetherActivity,
  ): Promise<TogetherSession | null> {
    const response = await this.request(apiPaths.together.create, {
      method: "POST",
      body: { activity },
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(togetherSessionResponseSchema, response).session;
  }

  public async respondToTogetherSession(
    id: string,
    response: "accepted" | "declined",
  ): Promise<TogetherSession | null> {
    const body = await this.request(apiPaths.together.respond(id), {
      method: "POST",
      body: { response },
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(togetherSessionResponseSchema, body).session;
  }

  /** Publishes derived state only; there is no field here for media. */
  public async publishTogetherState(
    id: string,
    state: TogetherStateInput,
  ): Promise<TogetherSession | null> {
    const body = await this.request(apiPaths.together.state(id), {
      method: "PUT",
      body: state,
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(togetherSessionResponseSchema, body).session;
  }

  public async endTogetherSession(id: string): Promise<TogetherSession | null> {
    const body = await this.request(apiPaths.together.end(id), {
      method: "POST",
      body: {},
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(togetherSessionResponseSchema, body).session;
  }

  // MARK: - Assistant memory

  public async bloodPressureReadings(
    signal?: AbortSignal,
  ): Promise<BloodPressureList> {
    const response = await this.request(apiPaths.bloodPressure.list, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    return parseContract(bloodPressureListResponseSchema, response);
  }

  public async recordBloodPressure(input: {
    systolic: number;
    diastolic: number;
    pulseBpm: number | null;
    measuredAt: string;
    note: string | null;
  }): Promise<BloodPressureReading> {
    const response = await this.request(apiPaths.bloodPressure.create, {
      method: "POST",
      body: input,
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(bloodPressureResponseSchema, response).reading;
  }

  public async deleteBloodPressure(id: string): Promise<void> {
    await this.request(apiPaths.bloodPressure.reading(id), {
      method: "DELETE",
      csrfProtected: true,
      retryAfterRefresh: true,
    });
  }

  public async aiMemories(signal?: AbortSignal): Promise<AiMemoryList> {
    const response = await this.request(apiPaths.ai.memories, {
      ...(signal ? { signal } : {}),
      retryAfterRefresh: true,
    });
    return parseContract(aiMemoryListResponseSchema, response);
  }

  public async addAiMemory(input: {
    category: AiMemoryCategory;
    content: string;
  }): Promise<AiMemory> {
    const response = await this.request(apiPaths.ai.memories, {
      method: "POST",
      body: input,
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(aiMemoryResponseSchema, response).memory;
  }

  public async deleteAiMemory(id: string): Promise<void> {
    await this.request(apiPaths.ai.memory(id), {
      method: "DELETE",
      csrfProtected: true,
      retryAfterRefresh: true,
    });
  }

  public async forgetAllAiMemories(): Promise<void> {
    await this.request(apiPaths.ai.memories, {
      method: "DELETE",
      csrfProtected: true,
      retryAfterRefresh: true,
    });
  }

  public async realtimeTicket(lastEventId?: string): Promise<RealtimeTicket> {
    const response = await this.request(apiPaths.realtime.ticket, {
      method: "POST",
      body: lastEventId ? { lastEventId } : {},
      csrfProtected: true,
      retryAfterRefresh: true,
    });
    return parseContract(realtimeTicketResponseSchema, response);
  }

  public realtimeUrl(ticket: RealtimeTicket): string {
    const url = new URL(ticket.webSocketUrl);
    const expected = resolveApiUrl(apiPaths.realtime.socket);
    const expectedSocketProtocol =
      expected.protocol === "https:" ? "wss:" : "ws:";
    if (
      url.protocol !== expectedSocketProtocol ||
      url.host !== expected.host ||
      url.pathname !== expected.pathname ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new ApiError(502, {
        type: "about:blank",
        title: "Invalid realtime endpoint",
        status: 502,
        detail: "The service returned an unsafe realtime endpoint.",
        code: "realtime_endpoint_invalid",
      });
    }
    return url.toString();
  }

  public realtimeProtocols(ticket: RealtimeTicket): string[] {
    return [...realtimeWebSocketProtocols(ticket.ticket)];
  }

  private async issueAnonymousCsrf(): Promise<string> {
    const response = await this.request(apiPaths.auth.csrf);
    if (
      !response ||
      typeof response !== "object" ||
      !("csrfToken" in response) ||
      typeof response.csrfToken !== "string"
    ) {
      throw new ApiError(502, {
        type: "about:blank",
        title: "Security token unavailable",
        status: 502,
        detail: "RafayPair could not establish a protected sign-in request.",
        code: "csrf_token_invalid",
      });
    }
    return response.csrfToken;
  }

  private async refreshSession(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.request(apiPaths.auth.refresh, {
        method: "POST",
        body: {},
        csrfProtected: true,
      })
        .then((response) => {
          parseContract(authResponseSchema, response);
          return undefined;
        })
        .finally(() => {
          this.refreshPromise = undefined;
        });
    }

    return this.refreshPromise;
  }

  private async request<TBody = never>(
    path: string,
    options: RequestOptions<TBody> = {},
  ): Promise<unknown> {
    const headers = new Headers({
      Accept: "application/json",
      [CLIENT_HEADER_NAME]: "web",
    });

    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");

    if (options.csrfProtected) {
      const csrfToken = options.csrfToken ?? readCookie(CSRF_COOKIE_NAME);
      if (!csrfToken) {
        throw new ApiError(403, {
          type: "about:blank",
          title: "Security token unavailable",
          status: 403,
          detail:
            "Your secure session could not be verified. Sign in again and retry.",
          code: "csrf_token_missing",
        });
      }
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }

    let response: Response;
    try {
      response = await fetch(resolveApiUrl(path), {
        method: options.method ?? "GET",
        credentials: "include",
        cache: "no-store",
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      throw new ApiError(0, {
        type: "about:blank",
        title: "Connection unavailable",
        status: 0,
        detail:
          "RafayPair could not reach the service. Check your connection and retry.",
        code: "network_unavailable",
      });
    }

    if (response.status === 401 && options.retryAfterRefresh) {
      await this.refreshSession();
      return this.request(path, { ...options, retryAfterRefresh: false });
    }

    if (!response.ok)
      throw new ApiError(response.status, await readProblem(response));
    return parseResponse(response);
  }
}

export const apiClient = new ApiClient();
