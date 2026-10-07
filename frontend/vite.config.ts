import { fileURLToPath } from "node:url";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    // Vite не читает paths из tsconfig.json для алиасов: сборка работает
    // (её ведёт плагин React Router), а вот `vite dev` падал с 500 на
    // каждом маршруте, не сумев разрешить `~/...`. Поэтому алиас дублируется
    // здесь явно — иначе разработка локально невозможна.
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // В dev-режиме backend поднимается отдельно, фронт ходит к нему напрямую.
    proxy: {
      "/api": {
        target: process.env.API_INTERNAL_URL ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});