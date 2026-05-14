import { expect, test } from "@playwright/test";

test("new mobile session hides transient rollout races and then renders", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile coverage");

  await page.goto("/?mock=e2e");
  await page.getByLabel("New session").click();
  await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  await page.getByPlaceholder("Ask Codex to start work...").fill("Start from mobile");
  await page.getByRole("button", { name: "Create session" }).click();

  await expect(page).toHaveURL(/\/sessions\/mock-new-session/);
  await expect(page.getByText(/no rollout found/i)).toHaveCount(0);
  await expect(page.getByText(/rollout .* is empty/i)).toHaveCount(0);
  await expect(page.getByText("Send the first message to start this session.")).toHaveCount(0);
  await expect(page.locator(".item-user").filter({ hasText: "Start from mobile" })).toHaveCount(1);
  await expect(page.getByText("Session is ready on mobile.")).toBeVisible();
  await expect(page.locator(".item-user").filter({ hasText: "Start from mobile" })).toHaveCount(1);
});

test("existing mobile chat keeps a pending user message visible exactly once", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile coverage");

  await page.goto("/sessions/mock-existing-session?mock=e2e");
  await expect(page.getByText("Hi.")).toBeVisible();
  await page.getByPlaceholder("Message Codex...").fill("I see double");
  await page.getByLabel("Send").click();

  const sentBubble = page.locator(".item-user").filter({ hasText: "I see double" });
  for (let index = 0; index < 8; index += 1) {
    await expect(sentBubble).toHaveCount(1);
    await page.waitForTimeout(80);
  }
  await expect(page.getByText("Working from the test fixture.")).toBeVisible();
  await expect(page.locator(".markdown-body strong", { hasText: "from" })).toBeVisible();
  await expect(sentBubble).toHaveCount(1);
});

test("mobile session controls are visible and tappable", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile coverage");

  await page.goto("/sessions/mock-existing-session?mock=e2e");
  await expect(page.getByLabel("Back")).toBeVisible();
  await expect(page.getByLabel("Refresh thread")).toBeVisible();
  await expect(page.getByLabel("Scroll to latest")).toBeVisible();
  await expect(page.getByLabel("Send")).toBeVisible();
});

test("mobile approvals open at the bottom of long threads", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile coverage");

  await page.goto("/sessions/mock-existing-session?mock=e2e&approval=1&long=1");
  await expect(page.getByLabel("Pending approvals")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  await expectPageAtBottom(page);

  const approvalTop = await page.getByLabel("Pending approvals").evaluate((node) => node.getBoundingClientRect().top);
  const composerTop = await page.locator(".composer").evaluate((node) => node.getBoundingClientRect().top);
  expect(approvalTop).toBeLessThan(composerTop);
  expect(approvalTop).toBeGreaterThan(120);
});

test("mobile inbox surfaces ready attention when Codex returns to idle", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("mobile"), "mobile coverage");

  await page.goto("/?mock=e2e&ready=1");
  await expect(page.getByText("Codex is ready")).toBeVisible();
  await expect(page.getByText("waiting for instructions")).toBeVisible();
});

test("desktop paired views are keyboard reachable and do not overflow", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes("desktop"), "desktop coverage");

  await page.goto("/?mock=e2e");
  await expect(page.getByText("Reply with exactly MOBILE_E2E_OK")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Refresh sessions")).toBeFocused();
  await expectHorizontalOverflow(page, 0);

  await page.getByText("Reply with exactly MOBILE_E2E_OK").click();
  await expect(page.getByLabel("Refresh thread")).toBeVisible();
  await expect(page.getByPlaceholder("Message Codex...")).toBeVisible();
  await expectHorizontalOverflow(page, 0);
});

async function expectHorizontalOverflow(page: { evaluate: <T>(fn: () => T) => Promise<T> }, maxPx: number): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(maxPx);
}

async function expectPageAtBottom(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scrollBottom = window.scrollY + window.innerHeight;
        const documentBottom = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        return documentBottom - scrollBottom;
      })
    )
    .toBeLessThanOrEqual(2);
}
