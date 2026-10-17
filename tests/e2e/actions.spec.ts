import { expect, test } from "@playwright/test";
import { askIncident, freshApp, ingest } from "./helpers";

test.beforeEach(async ({ page }) => { await freshApp(page); });

const tickets = (page: import("@playwright/test").Page) => page.getByRole("list", { name: "Tickets" }).locator("li");

test("Warden denies the intern: a reason, a decision id, and no ticket", async ({ page }) => {
  await page.getByRole("button", { name: "Propose escalation" }).click();
  await expect(page.getByText(/escalate INC-102 \(sev1, open\) to Payments/)).toBeVisible();
  await page.getByLabel("Acting as").selectOption("intern");
  await page.getByRole("button", { name: "Confirm as intern" }).click();
  const card = page.locator(".decision.deny");
  await expect(card).toContainText("Warden: Denied");
  await expect(card).toContainText("interns may not escalate incidents");
  await expect(card).toContainText("No ticket was created.");
  await expect(card.locator(".mono")).toContainText(/decision [0-9a-f]{16}/);
  await expect(tickets(page)).toHaveCount(0);
  await expect(page.locator('.node[data-type="Ticket"]')).toHaveCount(0);
});

test("Warden allows the sre: one ticket, linked in the graph, idempotent on retry", async ({ page }) => {
  await page.getByRole("button", { name: "Propose escalation" }).click();
  await page.getByRole("button", { name: "Confirm as sre" }).click();
  const card = page.locator(".decision.allow");
  await expect(card).toContainText("Warden: Allowed");
  await expect(card).toContainText("Ticket created:");
  await expect(card).toContainText("assigned to payments");
  await expect(tickets(page)).toHaveCount(1);
  await expect(page.locator('.node[data-type="Ticket"]')).toHaveCount(1);

  const id = (await tickets(page).first().locator("strong").first().textContent())!;
  await page.getByRole("button", { name: "Confirm as sre" }).click();
  await expect(page.locator(".decision.allow")).toContainText("Existing ticket returned");
  await expect(tickets(page)).toHaveCount(1);
  await expect(tickets(page).first()).toContainText(id);
});

test("every decision lands in a verifiable audit chain", async ({ page }) => {
  await page.getByRole("button", { name: "Propose escalation" }).click();
  await page.getByLabel("Acting as").selectOption("intern");
  await page.getByRole("button", { name: "Confirm as intern" }).click();
  await expect(page.getByText(/Warden audit chain: \d+ decisions?, hash chain valid\./)).toBeVisible();
  await page.getByLabel("Acting as").selectOption("sre");
  await page.getByRole("button", { name: "Confirm as sre" }).click();
  await expect(page.getByText(/Warden audit chain: [2-9]\d* decisions, hash chain valid\./)).toBeVisible();
});

test("a draft built before the ownership change is dropped, and the new draft targets the new owner", async ({ page }) => {
  await page.getByRole("button", { name: "Propose escalation" }).click();
  await expect(page.getByText(/to Payments/).first()).toBeVisible();
  await ingest(page);
  await expect(page.getByRole("button", { name: "Propose escalation" })).toBeVisible(); // stale draft gone
  await page.getByRole("button", { name: "Propose escalation" }).click();
  await expect(page.getByText(/escalate INC-102 \(sev1, open\) to Commerce Reliability/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm as sre" }).click();
  await expect(page.locator(".decision.allow")).toContainText("assigned to commerce-reliability");
});

test("memory: saved investigations are recalled in a new session and matched against the graph", async ({ page }) => {
  await askIncident(page);
  await page.getByRole("button", { name: "Save investigation" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(page.getByText("Nothing asked yet.")).toBeVisible(); // the new session starts empty
  const mem = page.locator(".mem").first();
  await expect(mem).toContainText("Remembered");
  await expect(mem).toContainText("Matches graph");
  await expect(mem).toContainText("owned by Payments");
});

test("memory: when ownership changed after saving, the memory is flagged and the graph wins", async ({ page }) => {
  await askIncident(page);
  await page.getByRole("button", { name: "Save investigation" }).click();
  await ingest(page);
  await page.getByRole("button", { name: "New session" }).click();
  const mem = page.locator(".mem").first();
  await expect(mem).toContainText("Out of date");
  await expect(mem).toContainText("Owner of payment-queue changed from Payments to Commerce Reliability");
  await expect(mem).toContainText("ownership-payment-queue-20261016");
});

test("Save investigation needs an investigation to save", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Save investigation" })).toBeDisabled();
});

test("Reset demo clears the ticket list along with the graph", async ({ page }) => {
  await page.getByRole("button", { name: "Propose escalation" }).click();
  await page.getByRole("button", { name: "Confirm as sre" }).click();
  await expect(tickets(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Reset demo" }).click();
  await page.getByRole("button", { name: "Yes, reset" }).click();
  await expect(page.getByText("Nothing asked yet.")).toBeVisible();
  await expect(tickets(page)).toHaveCount(0);
});
