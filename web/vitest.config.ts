import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: [],
  },
  resolve: {
    alias: { "@": "/src" },
  },
});
