/** @type {import('tailwindcss').Config} */
const colors = require("tailwindcss/colors")

module.exports = {
  content: ["./src/**/*.{html,tsx}"],
  theme: {
    extend: {
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
