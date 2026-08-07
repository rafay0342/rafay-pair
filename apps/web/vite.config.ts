import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults, defineConfig } from "vitest/config";

function sourceBytes(output: OutputAsset | OutputChunk): Uint8Array {
  if (output.type === "chunk") return new TextEncoder().encode(output.code);
  if (typeof output.source === "string")
    return new TextEncoder().encode(output.source);
  return output.source;
}

function subresourceIntegrity() {
  return {
    name: "rafaypair-subresource-integrity",
    enforce: "post" as const,
    generateBundle(_: unknown, bundle: OutputBundle) {
      const index = bundle["index.html"];
      if (!index || index.type !== "asset" || typeof index.source !== "string")
        return;

      index.source = index.source.replace(
        /<(script|link)\b([^>]*?)(?:src|href)="\/?(assets\/[^"]+)"([^>]*)>/gu,
        (
          tag,
          element: string,
          before: string,
          assetPath: string,
          after: string,
        ) => {
          const asset = bundle[assetPath];
          if (!asset) return tag;
          const integrity = `sha384-${createHash("sha384").update(sourceBytes(asset)).digest("base64")}`;
          const existingAttributes = `${before}${after}`;
          const crossOrigin = /\bcrossorigin(?:=|\s|$)/u.test(
            existingAttributes,
          )
            ? ""
            : ' crossorigin="anonymous"';
          return `<${element}${before}${element === "script" ? "src" : "href"}="/${assetPath}"${after} integrity="${integrity}"${crossOrigin}>`;
        },
      );
    },
  };
}

const developmentHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; worker-src 'self'",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "service-worker.ts",
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        id: "/",
        name: "RafayPair",
        short_name: "RafayPair",
        description: "Private, consent-led care for two people.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#f5f1e8",
        theme_color: "#162d2a",
        categories: ["health", "lifestyle"],
        icons: [
          {
            src: "/pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,ico,png,webmanifest}"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
    subresourceIntegrity(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
  },
  build: {
    target: "es2022",
    sourcemap: "hidden",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            /[\\/]node_modules[\\/](?:react(?:-dom)?|react-router(?:-dom)?)[\\/]/u.test(
              id,
            )
          ) {
            return "react";
          }
          return undefined;
        },
      },
    },
  },
  preview: { headers: developmentHeaders },
  server: { headers: developmentHeaders },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    env: {
      VITE_API_BASE_URL: "http://127.0.0.1:3000",
    },
    css: true,
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      reporter: ["text", "html"],
      exclude: ["src/main.tsx", "src/service-worker.ts"],
    },
  },
});
