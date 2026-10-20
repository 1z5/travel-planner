import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["lib/**/*.ts", "components/**/*.tsx", "app/**/*.{ts,tsx}"],
      exclude: [
        "lib/auth/**",
        "lib/store/postgres.ts",
        "app/api/auth/**",
        "**/*.d.ts",
        "**/*.config.*",
      ],
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 40,
        statements: 50,
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^server-only$/,
        replacement: fileURLToPath(new URL("./tests/stubs/server-only.js", import.meta.url)),
      },
      { find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) },
    ],
  },
});
