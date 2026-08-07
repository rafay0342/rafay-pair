import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const sdk = endpoint
  ? new NodeSDK({
      serviceName: process.env.OTEL_WORKER_SERVICE_NAME ?? "rafay-pair-worker",
      traceExporter: new OTLPTraceExporter({
        url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
      }),
    })
  : undefined;

sdk?.start();

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
