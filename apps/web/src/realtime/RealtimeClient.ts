import { realtimeEventEnvelopeSchema } from "@rafay-pair/api-contracts";

import type { ApiClient } from "../api/client";
import type { RealtimeEnvelope, RealtimeStatus } from "../domain/types";

export interface RealtimeSnapshot {
  readonly status: RealtimeStatus;
  readonly lastConnectedAt?: string;
  readonly reconnectAttempt: number;
}

interface RealtimeClientOptions {
  readonly api: ApiClient;
  readonly createSocket?: (url: string, protocols: string[]) => WebSocket;
  readonly random?: () => number;
  readonly setDelay?: (callback: () => void, delay: number) => number;
  readonly clearDelay?: (timer: number) => void;
}

type EventListener = (event: RealtimeEnvelope) => void;
type StatusListener = (snapshot: RealtimeSnapshot) => void;

const BASE_RECONNECT_DELAY_MS = 750;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_DEDUPLICATION_IDS = 250;

function isRealtimeEnvelope(value: unknown): value is RealtimeEnvelope {
  return realtimeEventEnvelopeSchema.safeParse(value).success;
}

export class RealtimeClient {
  private readonly api: ApiClient;
  private readonly createSocket: (
    url: string,
    protocols: string[],
  ) => WebSocket;
  private readonly random: () => number;
  private readonly setDelay: (callback: () => void, delay: number) => number;
  private readonly clearDelay: (timer: number) => void;
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly receivedEventIds = new Set<string>();
  private socket: WebSocket | undefined;
  private reconnectTimer: number | undefined;
  private lastEventId: string | undefined;
  private running = false;
  private generation = 0;
  private snapshot: RealtimeSnapshot = { status: "idle", reconnectAttempt: 0 };

  public constructor(options: RealtimeClientOptions) {
    this.api = options.api;
    this.createSocket =
      options.createSocket ??
      ((url, protocols) => new WebSocket(url, protocols));
    this.random = options.random ?? Math.random;
    this.setDelay =
      options.setDelay ??
      ((callback, delay) => window.setTimeout(callback, delay));
    this.clearDelay =
      options.clearDelay ?? ((timer) => window.clearTimeout(timer));
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    void this.connect(this.generation);
  }

  public stop(): void {
    this.running = false;
    this.generation += 1;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    if (this.reconnectTimer !== undefined) {
      this.clearDelay(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      socket.close(1000, "Client stopped");
    }
    this.updateSnapshot({ status: "idle", reconnectAttempt: 0 });
  }

  public resetRecoveryState(): void {
    this.stop();
    this.lastEventId = undefined;
    this.receivedEventIds.clear();
  }

  public subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.snapshot);
    return () => this.statusListeners.delete(listener);
  }

  public getSnapshot(): RealtimeSnapshot {
    return this.snapshot;
  }

  private readonly handleOnline = (): void => {
    if (!this.running || this.socket) return;
    this.generation += 1;
    void this.connect(this.generation);
  };

  private readonly handleOffline = (): void => {
    if (this.socket) {
      const socket = this.socket;
      this.socket = undefined;
      socket.close(1001, "Network offline");
    }
    this.updateSnapshot({ status: "offline" });
  };

  private async connect(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation) return;
    if (!navigator.onLine) {
      this.updateSnapshot({ status: "offline" });
      return;
    }

    this.updateSnapshot({
      status: this.lastEventId ? "recovering" : "connecting",
    });

    try {
      const ticket = await this.api.realtimeTicket(this.lastEventId);
      if (!this.running || generation !== this.generation) return;

      const socket = this.createSocket(
        this.api.realtimeUrl(ticket),
        this.api.realtimeProtocols(ticket),
      );
      this.socket = socket;

      socket.addEventListener("open", () => {
        if (socket !== this.socket) return;
        this.updateSnapshot({
          status: "connected",
          reconnectAttempt: 0,
          lastConnectedAt: new Date().toISOString(),
        });
      });

      socket.addEventListener("message", (message) => {
        if (socket !== this.socket || typeof message.data !== "string") return;
        this.receive(message.data);
      });

      socket.addEventListener("close", () => {
        if (socket !== this.socket) return;
        this.socket = undefined;
        this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        if (socket === this.socket) socket.close();
      });
    } catch {
      if (this.running && generation === this.generation)
        this.scheduleReconnect();
    }
  }

  private receive(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (
      !isRealtimeEnvelope(parsed) ||
      this.receivedEventIds.has(parsed.eventId)
    )
      return;

    this.lastEventId = parsed.eventId;
    this.receivedEventIds.add(parsed.eventId);
    if (this.receivedEventIds.size > MAX_DEDUPLICATION_IDS) {
      const oldestId = this.receivedEventIds.values().next().value;
      if (typeof oldestId === "string") this.receivedEventIds.delete(oldestId);
    }

    for (const listener of this.eventListeners) listener(parsed);
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    if (!navigator.onLine) {
      this.updateSnapshot({ status: "offline" });
      return;
    }

    const attempt = this.snapshot.reconnectAttempt + 1;
    const exponentialDelay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      BASE_RECONNECT_DELAY_MS * 2 ** Math.min(attempt - 1, 6),
    );
    const jitteredDelay = Math.round(
      exponentialDelay * (0.75 + this.random() * 0.5),
    );

    this.updateSnapshot({ status: "recovering", reconnectAttempt: attempt });
    this.reconnectTimer = this.setDelay(() => {
      this.reconnectTimer = undefined;
      this.generation += 1;
      void this.connect(this.generation);
    }, jitteredDelay);
  }

  private updateSnapshot(update: Partial<RealtimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.statusListeners) listener(this.snapshot);
  }
}
