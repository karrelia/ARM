import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Запити /api проксіюються на FastAPI (порт 8000), щоб уникнути CORS у dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
