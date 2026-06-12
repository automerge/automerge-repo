import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e.html")
})

test("does not materialize changes from a revoked author", async ({ page }) => {
  const result = await page.evaluate(() =>
    window.todoDemoE2E.revokedAuthorChangeIsNotMaterialized()
  )

  expect(result.beforeRevocation).toMatchObject({
    title: "created",
    accepted: "bob-before-revocation",
  })
  expect(result.afterRevocation).toMatchObject({
    title: "created",
  })
  expect(result.afterRevocation?.rejected).toBeUndefined()
  expect(result.rejectedVerifications).toBeGreaterThan(0)
  expect(result.missingSignatures).toBe(0)
})

test("keeps pre-revocation changes visible", async ({ page }) => {
  const result = await page.evaluate(() =>
    window.todoDemoE2E.revokedAuthorChangeIsNotMaterialized()
  )

  expect(result.beforeRevocation).toMatchObject({
    accepted: "bob-before-revocation",
  })
  expect(result.afterRevocation).toMatchObject({
    accepted: "bob-before-revocation",
  })
  expect(result.afterRevocation?.rejected).toBeUndefined()
})

test("does not materialize falsely attributed changes", async ({ page }) => {
  const result = await page.evaluate(() =>
    window.todoDemoE2E.falselyAttributedChangeIsNotMaterialized()
  )

  expect(result.afterRejected).toMatchObject({ title: "created" })
  expect(result.afterRejected?.forged).toBeUndefined()
  expect(result.rejectedVerifications).toBeGreaterThan(0)
  expect(result.missingSignatures).toBe(0)
})
