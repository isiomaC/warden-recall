import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { freshApp, incidentPreset } from "./helpers";

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("panels are reachable by tabs and the question still works", async ({ page }) => {
    await freshApp(page);
    await page.getByRole("button", { name: incidentPreset }).click();
    await expect(page.locator(".headline")).toContainText("INC-102");
    await page.getByRole("tab", { name: "Graph" }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.getByRole("tab", { name: /^Cypher/ }).click();
    await expect(page.locator("pre.cypher").first()).toBeVisible();
    await page.getByRole("tab", { name: "Actions" }).click();
    await expect(page.getByRole("button", { name: "Propose escalation" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("dark mode", () => {
  test.use({ colorScheme: "dark" });
  test("renders with dark tokens and still works", async ({ page }) => {
    await freshApp(page);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightness = bg.match(/\d+/g)!.slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
    expect(lightness).toBeLessThan(80);
    await page.getByRole("button", { name: incidentPreset }).click();
    await expect(page.locator(".headline")).toContainText("INC-102");
  });
});

// Runs last: it stops the database. It fails closed, and recovers once FalkorDB is back.
test.describe.serial("FalkorDB outage", () => {
  const compose = (cmd: string) => execSync(`docker compose ${cmd}`, { cwd: process.cwd(), stdio: "pipe" });
  test.afterAll(() => { compose("start falkordb"); });

  test("the app says so, shows no answer, and recovers when the database returns", async ({ page }) => {
    await freshApp(page);
    compose("stop falkordb");
    await page.getByRole("button", { name: incidentPreset }).click();
    await expect(page.getByRole("alert").first()).toContainText("FalkorDB is unreachable");
    await expect(page.locator(".status")).toContainText("FalkorDB unreachable");
    await expect(page.locator(".headline")).toHaveCount(0);
    await expect(page.locator(".claim")).toHaveCount(0);

    compose("start falkordb");
    await expect(async () => {
      await page.getByRole("button", { name: "Retry" }).click();
      await expect(page.locator(".status")).toContainText("FalkorDB connected", { timeout: 2000 });
    }).toPass({ timeout: 30_000, intervals: [1000] });
    await page.getByRole("button", { name: incidentPreset }).click();
    await expect(page.locator(".headline")).toContainText("INC-102");
  });
});
