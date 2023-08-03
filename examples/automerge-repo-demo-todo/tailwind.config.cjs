/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors")

const emoji = "Segoe UI Emoji"
const mono = "IBM Plex Mono"
const sans = "IBM Plex Sans"
const condensed = "IBM Plex Sans Condensed"
const serif = "IBM Plex Serif"

module.exports = {
  content: ["./**/*.{html,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: [mono, emoji, "monospace"],
        sans: [sans, emoji, "sans-serif"],
        condensed: [condensed, emoji, "sans-serif"],
        serif: [serif, emoji, "serif"],
      },
      zIndex: {},
      colors: {
        primary: colors.blue,
        secondary: colors.teal,
        neutral: colors.gray,
        success: colors.green,
        warning: colors.orange,
        danger: colors.red,
      },
      fontWeight: {
        thin: 200,
        normal: 500,
        bold: 600,
        extrabold: 800,
      },
    },
  },
  variants: {
    opacity: ({ after }) => after(["group-hover", "group-focus", "disabled"]),
    textColor: ({ after }) => after(["group-hover", "group-focus"]),
    boxShadow: ({ after }) => after(["group-hover", "group-focus"]),
  },
}
