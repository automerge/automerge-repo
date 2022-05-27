module.exports = {
  env: {
    browser: true,
    es2021: true,
  },
  extends: [
    'airbnb-base',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    semi: ['error', 'never'],
    'import/extensions': 0,
    'lines-between-class-members': 0,
    'no-param-reassign': 0,
    'no-use-before-define': 0,
  },
}
