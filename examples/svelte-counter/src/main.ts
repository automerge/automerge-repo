import "./app.css"
import App from "./App.svelte"
import { mount } from "svelte"
import { setupRepo } from "./lib/repo.js"

const target = document.getElementById("app")
if (!target) throw new Error("Missing mount target: #app")

const repo = await setupRepo()

mount(App, {
  target,
  props: { repo },
})
