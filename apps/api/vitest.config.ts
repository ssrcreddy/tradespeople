import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          globalSetup: ["test/integration/globalSetup.ts"],
          fileParallelism: false,       // one shared test database
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
