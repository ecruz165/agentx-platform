import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Phase 6 dev config: proxy all /api/* requests to the running Spring
// controlplane (default port 8080). Tenant headers are forwarded from
// the browser so the existing DevModeTenantContextFilter works without
// CORS configuration on the Spring side.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: false,
      },
    },
  },
  build: {
    // Build output goes to controlplane/src/main/resources/static/
    // when packaged for prod (handled by a Maven copy step at build time).
    outDir: "dist",
    sourcemap: true,
  },
});
