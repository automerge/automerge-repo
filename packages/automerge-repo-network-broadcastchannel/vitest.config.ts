import { defineConfig, mergeConfig } from "vitest/config"
import { sharedConfig } from "../../vitest.config"

export default mergeConfig(sharedConfig, defineConfig({}))
