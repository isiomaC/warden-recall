import { expect, test } from "@playwright/test";
import { askIncident, freshApp } from "./helpers";

test.beforeEach(async ({ page }) => { await freshApp(page); });

test("first frame: connected, the whole company graph is drawn, nothing is claimed yet", async ({ page }) => {
  await expect(page.locator(".status")).toContainText("FalkorDB connected, 37 nodes");
  await expect(page.locator(".header-meta")).toContainText("demo clock");
  await expect(page.locator(".react-flow__edge")).toHaveCount(21);
  await expect(page.getByText("Nothing asked yet.")).toBeVisible();
  await expect(page.getByText("No evidence yet.")).toBeVisible();
  await expect(page.locator(".node.hit")).toHaveCount(0);
});

test("incident question: grounded answer, owners, projects, on-call, decisions", async ({ page }) => {
  await askIncident(page);
  await expect(page.locator(".headline")).toContainText("Payment Queue is failing. 3 dependent services affected; owned by Payments.");
  await expect(page.getByText(/Checkout API depends on Payment Queue \(1 hop/)).toBeVisible();
  await expect(page.getByText(/Checkout Web depends on Payment Queue \(2 hops/)).toBeVisible();
  await expect(page.getByText(/Mobile App depends on Payment Queue \(2 hops/)).toBeVisible();
  await expect(page.getByText("Subscription Renewal uses payment-queue directly")).toBeVisible();
  await expect(page.getByText(/Holiday Checkout uses checkout-api, which depends on the failed service/)).toBeVisible();
  await expect(page.getByText("Alex Rivera (payments) is on call for payment-queue")).toBeVisible();
  await expect(page.getByText(/ADR-001 \(2026-09-02\).*amended by ADR-002.*still valid/)).toBeVisible();
  await expect(page.getByText("On-call matches the owning team.")).toBeVisible();
  await expect(page.locator(".asked")).toContainText("Checkout is down");
});

test("the graph highlights exactly the returned paths and dims the rest", async ({ page }) => {
  await askIncident(page);
  await expect(page.locator(".node.hit").first()).toBeVisible();
  expect(await page.locator(".node.dim").count()).toBeGreaterThan(0);
  expect(await page.locator(".react-flow__edge.hit").count()).toBeGreaterThan(5);
  // Billing Worker is not affected by a Payment Queue outage, so it must be dimmed, not highlighted
  await expect(page.locator(".node", { hasText: "Billing Worker" })).toHaveClass(/dim/);
  await expect(page.locator(".node", { hasText: "Checkout Web" })).toHaveClass(/hit/);
});

test("hovering a claim focuses its entities on the graph", async ({ page }) => {
  await askIncident(page);
  await page.getByText(/Checkout Web depends on Payment Queue/).hover();
  await expect(page.locator(".node.focus", { hasText: "Checkout Web" })).toBeVisible();
  await expect(page.locator(".node.focus", { hasText: "Payment Queue" })).toBeVisible();
  await expect(page.locator(".node", { hasText: "Mobile App" })).toHaveClass(/dim/);
});

test("evidence inspector: Cypher with parameters, sources with real Markdown, text paths", async ({ page }) => {
  await askIncident(page);
  await expect(page.getByRole("tab", { name: /^Cypher/ })).toBeVisible();
  await expect(page.locator("pre.cypher", { hasText: "MATCH p=(dep:Service)-[:DEPENDS_ON*1..4]->(failed:Service {id:$serviceId})" })).toBeVisible();
  await expect(page.locator(".chip", { hasText: '$serviceId = "payment-queue"' }).first()).toBeVisible();

  await page.getByRole("tab", { name: /^Sources/ }).click();
  await page.locator(".src-item", { hasText: "adr-001" }).click();
  await expect(page.locator(".doc-body")).toContainText("Introduce a durable Payment Queue");
  await expect(page.locator(".fm")).toContainText("kind");

  await page.getByRole("tab", { name: /^Paths/ }).click();
  await expect(page.locator(".paths li", { hasText: "checkout-web" }).first()).toContainText("DEPENDS_ON");
});

test("clicking a citation chip opens that source document", async ({ page }) => {
  await askIncident(page);
  await page.locator(".claims .chip", { hasText: "ownership-payment-queue-20261015" }).first().click();
  await expect(page.getByRole("tab", { name: /^Sources/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".doc-body")).toContainText("The payments team owns payment-queue");
});

test("clicking a graph node shows its relationships and opens its source", async ({ page }) => {
  await page.locator(".node", { has: page.locator('.node-id:text-is("payment-queue")') }).click();
  const detail = page.getByRole("region", { name: /Payment Queue details/ });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("DEPENDS_ON");
  await detail.getByRole("button", { name: "Open source" }).click();
  await expect(page.getByRole("tab", { name: /^Sources/ })).toHaveAttribute("aria-selected", "true");
});

test("ambiguous names ask for a choice, then answer", async ({ page }) => {
  await page.getByLabel("Ask the company brain").fill("Who owns checkout?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Which service?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Checkout API/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Checkout Web/ })).toBeVisible();
  await page.getByRole("button", { name: /Checkout API/ }).click();
  await expect(page.locator(".headline")).toContainText("Storefront owns checkout-api");
});

test("design questions cite ADRs; an amendment never invalidates the original", async ({ page }) => {
  await page.getByLabel("Ask the company brain").fill("Why was the payment queue introduced?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".headline")).toContainText("Decision history for Payment Queue");
  await expect(page.getByText(/ADR-002 \(2026-10-10\) amends ADR-001/)).toBeVisible();
  await expect(page.getByText(/superseded/i)).toHaveCount(0);
});

test("unsupported and unknown questions abstain instead of guessing", async ({ page }) => {
  await page.getByLabel("Ask the company brain").fill("What's the weather in Dublin?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Try one of these" })).toBeVisible();
  await expect(page.locator(".claim")).toHaveCount(0);

  await page.getByLabel("Ask the company brain").fill("Who owns the flux capacitor?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".headline")).toContainText("won't guess");
  await expect(page.locator(".claim")).toHaveCount(0);
});

test("keyboard: / focuses the question box", async ({ page }) => {
  await page.locator("body").click({ position: { x: 700, y: 400 } });
  await page.keyboard.press("/");
  await expect(page.getByLabel("Ask the company brain")).toBeFocused();
});
