import { defineConfig, mergeConfig } from "vitest/config"
import rootConfig from "../../vitest.config"

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      environment: "node",
    },
  })
)
