import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts", "resources/viewer/geometry.mjs", "resources/viewer/annotations.mjs", "resources/viewer/markdown.mjs"],
      reporter: ["text", "html", "lcovonly"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
