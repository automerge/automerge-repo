import { defineConfig } from "vitest/config"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "solid-js/web": "@solidjs/web",
    },
  },
  test: {
    globals: true,
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
        inline: [/solid-js/, /@solidjs/],
      },
    },
  },
})
