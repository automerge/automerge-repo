import { test, expect } from "@playwright/test"

test.describe("react-use-awareness", () => {
  test("clients can share ephemeral state", async ({
    page: pageA,
    context,
  }) => {
    const pageB = await context.newPage()

    await pageA.goto("/")
    await pageA.waitForURL("**#automerge:*")

    await pageB.goto(pageA.url())

    const inputA = pageA.getByLabel("Ephemeral state")
    inputA.fill("6")

    const inputB = pageB.getByLabel("Ephemeral state")
    inputB.fill("7")

    const peerStatesA = pageA.getByTestId("peer-states")
    const peerStatesB = pageB.getByTestId("peer-states")

    await expect(peerStatesA).toContainText('"count": "7"')
    await expect(peerStatesB).toContainText('"count": "6"')
  })
})
