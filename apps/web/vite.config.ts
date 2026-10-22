import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Behind a tunnel (ngrok) the app is opened on a public address, and the API paths are forwarded to the local API,
    // so one public URL serves the app, the API and the link-preview cards.
    allowedHosts: true,
    proxy: { "^/(v1|c|og)/": { target: "http://127.0.0.1:3001", changeOrigin: false } },
  },
  // `vite preview` serves the built app: one small bundle instead of hundreds of dev files, much faster through a tunnel.
  preview: {
    port: 5173,
    allowedHosts: true,
    proxy: { "^/(v1|c|og)/": { target: "http://127.0.0.1:3001", changeOrigin: false } },
  },
  define: { global: "globalThis" },
});
