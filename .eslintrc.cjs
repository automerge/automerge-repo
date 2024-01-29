const OFF = 0
const WARN = 1
const ERROR = 2
const NEVER = "never"
const ALWAYS = "always"

module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/eslint-recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  ignorePatterns: [
    "**/*.d.ts",
    "**/*.config.ts",
    "**/fuzz.ts",
    "examples/**/*",
    "**/test/*",
    "**/dist/*",
    "**/node_modules/*",
    ".eslintrc.cjs",
  ],
  overrides: [
    {
      env: { node: true },
      files: [".eslintrc.{js,cjs}"],
      parserOptions: { sourceType: "script" },
    },
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["./packages/*/tsconfig.json"],
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint"],
  rules: {
    semi: [ERROR, NEVER],
    "import/extensions": OFF,
    "lines-between-class-members": OFF,
    "@typescript-eslint/no-floating-promises": ERROR,
    "@typescript-eslint/no-empty-function": OFF,
    "no-param-reassign": OFF,
    "no-use-before-define": OFF,
    "@typescript-eslint/no-non-null-assertion": OFF,
    "@typescript-eslint/no-explicit-any": OFF,
    "@typescript-eslint/no-unused-vars": [ERROR, {"varsIgnorePattern": "^_"}],
  },
  root: true,
}
