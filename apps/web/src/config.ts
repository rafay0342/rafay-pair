const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim();

if (!configuredApiBaseUrl) {
  throw new Error("VITE_API_BASE_URL must be configured.");
}

export const runtimeConfig = Object.freeze({
  apiBaseUrl: configuredApiBaseUrl.replace(/\/$/u, ""),
  appVersion: __APP_VERSION__,
});

declare global {
  const __APP_VERSION__: string;
}
