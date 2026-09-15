import { defineConfig, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.config"
import solid from "vite-plugin-solid"

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [solid()],
    test: {
      // environment inherited from the root config (happy-dom)
      deps: {
        optimizer: {
          client: {
            enabled: true,
          },
        },
      },
      server: {
        deps: {
          inline: [/solid-js/],
        },
      },
    },
  })
)
