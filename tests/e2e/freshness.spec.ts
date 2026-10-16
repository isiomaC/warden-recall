import { expect, test } from "@playwright/test";
import { askIncident, custody, freshApp, ingest } from "./helpers";

test.beforeEach(async ({ page }) => { await freshApp(page); });

test("before the update: one open custody interval and a pending document", async ({ page }) => {
  await expect(page.getByText("update pending")).toBeVisible();
  await expect(custody(page).locator(".seg")).toHaveCount(1);
  await expect(custody(page).locator(".seg.past")).toHaveCount(0);
  await expect(custody(page)).toContainText("Payments");
  await expect(page.locator(".docprev")).toContainText("Commerce Reliability assumes ownership");
});

test("ingesting the ownership document changes the answer, the custody chain and the graph live", async ({ page }) => {
  await askIncident(page);
  await expect(page.locator(".headline")).toContainText("owned by Payments");

  await ingest(page);

  // the same question, re-asked automatically, now answers differently and says why
  await expect(page.locator(".changed")).toContainText("escalation target moved from Payments to Commerce Reliability");
  await expect(page.locator(".changed")).toContainText("ownership-payment-queue-20261016 superseded ownership-payment-queue-20261015");
  await expect(page.locator(".headline")).toContainText("owned by Commerce Reliability");
  await expect(page.getByText("Commerce Reliability owns payment-queue (since 2026-10-16)")).toBeVisible();

  // custody chain extends and the earlier owner is kept as history
  await expect(page.getByText("update applied")).toBeVisible();
  await expect(custody(page).locator(".seg")).toHaveCount(2);
  await expect(custody(page).locator(".seg.past")).toContainText("Payments");
  await expect(custody(page).locator(".seg:not(.past)")).toContainText("Commerce Reliability");
  await expect(page.getByRole("button", { name: "Ingest this document" })).toHaveCount(0);

  // the new ownership edge is drawn
  await expect(page.locator(".react-flow__edge.fresh")).toHaveCount(1);
});

test("ownership and on-call diverge after the transfer, and the answer says so", async ({ page }) => {
  await askIncident(page);
  await ingest(page);
  await expect(page.getByText(/On-call does not follow ownership.*Alex Rivera \(payments\).*does not transfer automatically/)).toBeVisible();
});

test("the ingest receipt reports exactly what changed", async ({ page }) => {
  await ingest(page);
  await expect(page.locator(".receipt")).toContainText("Ingested 1 document, closed 1 ownership interval, created 1 relationship.");
});

test("the source behind the new owner is the new document", async ({ page }) => {
  await askIncident(page);
  await ingest(page);
  await page.locator(".claims .chip", { hasText: "ownership-payment-queue-20261016" }).first().click();
  await expect(page.locator(".doc-body")).toContainText("Commerce Reliability assumes ownership of the Payment Queue");
});

test("Reset demo returns to the starting state", async ({ page }) => {
  await ingest(page);
  await expect(custody(page).locator(".seg")).toHaveCount(2);
  await page.getByRole("button", { name: "Reset demo" }).click();
  await page.getByRole("button", { name: "Yes, reset" }).click();
  await expect(custody(page).locator(".seg")).toHaveCount(1);
  await expect(page.getByText("update pending")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ingest this document" })).toBeVisible();
});

test("Reset demo asks before wiping", async ({ page }) => {
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByText("Wipe and reseed the demo?")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Reset demo" })).toBeVisible();
});
