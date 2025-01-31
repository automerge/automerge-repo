import typescriptEslint from "@typescript-eslint/eslint-plugin"
import pluginReact from "eslint-plugin-react"
import globals from "globals"
import tsParser from "@typescript-eslint/parser"
import path from "node:path"
import { fileURLToPath } from "node:url"
import js from "@eslint/js"
import { FlatCompat } from "@eslint/eslintrc"

// Necessary so that we can use `FlatCompat` for configs which haven't been
// migrated to eslint 9 yet. See https://eslint.org/docs/latest/use/configure/migration-guide#using-eslintrc-configs-in-flat-config
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

const automergeSlimImportRule = {
  meta: {
    name: "enforce-automerge-slim-import",
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        let isAutomergeProblem = false
        if (node.source.value === "@automerge/automerge") {
          isAutomergeProblem = true
        } else if (
          node.source.value.startsWith("@automerge/automerge/") &&
          !node.source.value.startsWith("@automerge/automerge/slim")
        ) {
          isAutomergeProblem = true
        }
        if (isAutomergeProblem) {
          context.report({
            node,
            message:
              "Import from @automerge/automerge/slim instead of @automerge/automerge",
          })
        }

        let isAutomergeRepoProblem = false
        if (node.source.value === "@automerge/automerge-repo") {
          isAutomergeRepoProblem = true
        } else if (
          node.source.value.startsWith("@automerge/automerge-repo/") &&
          !node.source.value.startsWith("@automerge/automerge-repo/slim")
        ) {
          isAutomergeRepoProblem = true
        }
        if (isAutomergeRepoProblem) {
          context.report({
            node,
            message:
              "Import from @automerge/automerge-repo/slim instead of @automerge/automerge-repo",
          })
        }
      },
    }
  },
}

export default [
  {
    ignores: [
      "**/*.d.ts",
      "**/*.config.ts",
      "**/fuzz.ts",
      "examples/**/*",
      "**/test/*",
      "**/dist/*",
      "**/node_modules/*",
      "**/.eslintrc.cjs",
      "packages/create-vite-app/**/*",
      "testSetup.ts",
    ],
  },
  {
    settings: {
      react: {
        version: "^18.2.0",
      },
    },
  },
  js.configs.recommended,
  pluginReact.configs.flat.recommended,
  pluginReact.configs.flat["jsx-runtime"],
  ...compat.extends(
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended"
  ),
  {
    ignores: [
      "packages/create-repo-node-app/postbuild.js",
      "eslint.config.mjs",
    ],
    plugins: {
      "@typescript-eslint": typescriptEslint,
      "automerge-slimport": {
        rules: {
          "enforce-automerge-slim-import": automergeSlimImportRule,
        },
      },
    },

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },

      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",

      parserOptions: {
        project: ["./packages/*/tsconfig.json"],
      },
    },

    rules: {
      semi: [2, "never"],
      "import/extensions": 0,
      "lines-between-class-members": 0,
      "@typescript-eslint/no-floating-promises": 2,
      "@typescript-eslint/no-empty-function": 0,
      "no-param-reassign": 0,
      "no-use-before-define": 0,
      "@typescript-eslint/no-non-null-assertion": 0,
      "@typescript-eslint/no-explicit-any": 0,

      "@typescript-eslint/no-unused-vars": [
        2,
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "automerge-slimport/enforce-automerge-slim-import": 2,
    },
  },
  {
    files: [
      "packages/create-repo-node-app/postbuild.js",
      "packages/create-vite-app/postbuild.js",
      "packages/create-vite-app/test.js",
    ],

    languageOptions: {
      globals: {
        ...globals.node,
      },

      ecmaVersion: 5,
      sourceType: "commonjs",
    },
  },
]
