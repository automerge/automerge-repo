import { defineConfig, mergeConfig } from "vitest/config"
import rootConfig from "../../vitest.config"
import solid from "vite-plugin-solid"

export default mergeConfig(
  rootConfig,
  defineConfig({
    plugins: [solid()],
    test: {
      environment: "jsdom",
      deps: {
        optimizer: {
          web: {
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
