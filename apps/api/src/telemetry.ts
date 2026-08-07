import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const sdk = endpoint
  ? new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME ?? "rafay-pair-api",
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
      }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint.replace(/\/$/, "")}/v1/metrics`,
        }),
        exportIntervalMillis: 60_000,
      }),
    })
  : undefined;

sdk?.start();

/**
 * The instruments this service records.
 *
 * Chosen for what has to be answerable during an incident and for nothing else.
 * None of them carries a user, pair, session, or account identifier: an
 * attribute here would end up in a metrics backend with a long retention and
 * loose access, which is exactly where identity should not accumulate. The
 * dimensions below are all small, closed sets.
 */
const meter = metrics.getMeter("rafay-pair-api");

/**
 * Authorization refusals, by failure code.
 *
 * Refusals only, and named so. A counter called "decisions" that in practice
 * only ever incremented on failure would make every dashboard built on it wrong
 * about the denominator. A rising count here means clients are asking for
 * something they should already know they cannot have, which is invisible in
 * traces unless you already suspect it.
 */
const authorizationRefusals = meter.createCounter(
  "rafaypair.authorization.refusals",
  {
    description:
      "Server-side authorization refusals, by failure code. No identifiers.",
  },
);

/**
 * Realtime deliveries that were withheld at the moment of delivery.
 *
 * Distinct from a consent denial on a request: this counts events that were
 * authorized when queued and refused when delivered, which is the path a
 * mid-flight revocation takes. If revocation ever stops taking effect in
 * flight, this goes quiet while traffic continues.
 */
const realtimeWithheld = meter.createCounter("rafaypair.realtime.withheld", {
  description:
    "Realtime events refused at delivery time, by reason. No identifiers.",
});

/** Tool calls the assistant asked for, by decision. */
const aiToolDecisions = meter.createCounter("rafaypair.ai.tool_decisions", {
  description: "AI tool authorization outcomes, by tool and decision.",
});

/**
 * Capture sessions are deliberately absent from this file.
 *
 * A metric named for the camera would be a metric that turns on with the
 * camera, and the point of the reachability invariant is that no server-side
 * concept of "the camera is running" exists at all.
 */

export function recordAuthorizationRefusal(code: string): void {
  authorizationRefusals.add(1, { code });
}

export function recordRealtimeWithheld(reason: string): void {
  realtimeWithheld.add(1, { reason });
}

export function recordAiToolDecision(tool: string, decision: string): void {
  aiToolDecisions.add(1, { tool, decision });
}

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
