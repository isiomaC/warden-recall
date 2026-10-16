import { expect, type Page } from "@playwright/test";

export const incidentPreset = /Checkout is down\. What is affected/;

/** Wipe and reseed the graph (and saved memories) through the real API so each test starts identical. */
export async function freshApp(page: Page) {
  const res = await page.request.post("/api/reset");
  expect(res.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator(".status")).toContainText("FalkorDB connected");
  await expect(page.locator(".react-flow__node")).toHaveCount(16);
}

export async function askIncident(page: Page) {
  await page.getByRole("button", { name: incidentPreset }).click();
  await expect(page.locator(".headline")).toContainText("INC-102");
}

export const ingest = async (page: Page) => {
  await page.getByRole("button", { name: "Ingest this document" }).click();
  await expect(page.getByText("Ingested 1 document")).toBeVisible();
};

export const custody = (page: Page) => page.getByRole("group", { name: "Custody of payment-queue" });
