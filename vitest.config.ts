import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            remoteBindings: false,
            miniflare: {
              bindings: {
                TURNSTILE_SECRET_KEY: "test-secret",
                SESSION_SIGNING_KEY: "test-signing-key",
                TURNSTILE_HOSTNAMES: "app.test, www.app.test",
                NEURON_DAILY_BUDGET: "100",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
        },
      },
    ],
  },
});
