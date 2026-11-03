import { expect, test, type Page, type Route } from "@playwright/test";

// `fast=1` skips the per-round animation delay; everything else is the real app on the real data.
const race = (query: string) => `/?${query}&fast=1`;

async function noWorker(page: Page) {
  // the static preview has no Worker; make that explicit and quick
  await page.route("**/api/**", (route) => route.fulfill({ status: 404, body: "not found" }));
}

async function runRace(page: Page) {
  await page.getByRole("button", { name: /run the race|restart/i }).click();
  await expect(page.locator("body")).toHaveAttribute("data-race", "done");
}

async function scoreboardText(page: Page) {
  return page.locator("#scoreboard").innerText();
}

test.describe("act 1", () => {
  test("loads the real dataset and frames the rules honestly", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=act1"));
    await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("#loading")).toBeHidden();
    await expect(page.locator("#stat-variants")).toHaveText("51,715");
    await expect(page.locator("#stat-visible")).toHaveText("58%");
    await expect(page.locator("#depth-bars [role=listitem]")).toHaveCount(10);
    await expect(page.getByText("the strategies don't get to see it")).toBeVisible();
  });

  test("the tolerance heatmap explains positions on hover", async ({ page, isMobile }) => {
    test.skip(isMobile, "hover");
    await noWorker(page);
    await page.goto(race("seed=heat"));
    const heatmap = page.locator("#heatmap");
    const box = (await heatmap.boundingBox())!;
    await page.mouse.move(box.x + box.width * (65.5 / 238), box.y + 10);
    await expect(page.locator("#heatmap-caption")).toContainText("Position 66 (Y · chromophore)");
  });
});

test.describe("act 2: the race", () => {
  test("runs four local strategies to the end and tells the story", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=e2e-main"));
    await runRace(page);

    await expect(page.locator("#scoreboard tr")).toHaveCount(4);
    await expect(page.locator("#commentary li")).toHaveCount(10);
    // the evolutionary profile never proposes a dark variant under the default settings
    await expect(page.locator('#scoreboard tr[data-strategy="profile"] [data-col="dark"]')).toHaveText("0");
    await expect(page.locator('.dark-counter[data-strategy="profile"] .dark-number')).toHaveText("0");
    await expect(page.locator("#race-status")).toContainText("Finished · seed e2e-main");
    await expect(page.locator("#chart canvas").first()).toBeVisible();

    const lesson = page.locator("#lesson");
    await expect(lesson).toBeVisible();
    await expect(lesson.locator(".verdicts li")).toHaveCount(4);
    await expect(lesson).toContainText("Why the protein language model struggled");
    await expect(lesson).toContainText("How narrow the peak is");
  });

  test("the same seed reproduces the same race", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=same-seed&radius=4"));
    await runRace(page);
    const first = await scoreboardText(page);
    await page.reload();
    await runRace(page);
    expect(await scoreboardText(page)).toBe(first);

    await page.goto(race("seed=other-seed&radius=4"));
    await runRace(page);
    expect(await scoreboardText(page)).not.toBe(first);
  });

  test("settings live in a shareable URL", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=share"));
    await page.getByLabel("Rounds").fill("6");
    await page.getByLabel("Max mutations from current best").fill("5");
    await page.getByLabel(/ESM-2/).uncheck();
    await page.getByLabel("Seed", { exact: true }).fill("shared-seed");
    await page.getByLabel("Seed", { exact: true }).dispatchEvent("change");
    await expect(page).toHaveURL(/seed=shared-seed/);
    await expect(page).toHaveURL(/rounds=6/);
    await expect(page).toHaveURL(/radius=5/);
    await expect(page).toHaveURL(/s=random%2Cconservative%2Cprofile/);

    await page.goto(page.url());
    await expect(page.getByLabel("Rounds")).toHaveValue("6");
    await expect(page.getByLabel(/ESM-2/)).not.toBeChecked();
    await runRace(page);
    await expect(page.locator("#scoreboard tr")).toHaveCount(3);
    await expect(page.locator("#commentary li")).toHaveCount(6);
  });

  test("the structure view highlights where a strategy mutated", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=structure"));
    await runRace(page);
    const panel = page.locator("#structure");
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toHaveAttribute("data-state", /ready|unavailable/, { timeout: 45_000 });
    if ((await panel.getAttribute("data-state")) === "ready") {
      await expect(panel).toHaveAttribute("data-highlighted", /^[1-9]\d*$/, { timeout: 30_000 });
      await page.locator("#structure-strategy").selectOption("random");
      await expect(panel).toHaveAttribute("data-highlighted", /^[1-9]\d*$/);
    } else {
      await expect(panel.locator(".structure-status")).toContainText("unavailable");
    }
  });

  test("no horizontal scrolling", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=layout&s=random,conservative,esm,profile,llm"));
    await runRace(page);
    const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

test.describe("the LLM strategy", () => {
  test("is off by default", async ({ page }) => {
    await noWorker(page);
    await page.goto("/?fast=1");
    await expect(page.getByLabel(/^LLM/)).not.toBeChecked();
    await expect(page.locator("#llm-mode")).toBeHidden();
  });

  test("plays the recorded run for free, fallbacks flagged", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=recorded"));
    await page.getByLabel(/^LLM/).check();
    await expect(page.locator("#llm-note")).toContainText("Plays back a run recorded with @cf/meta/llama-3.2-3b-instruct");
    await runRace(page);

    await expect(page.locator("#scoreboard tr")).toHaveCount(5);
    await expect(page.locator("#reasoning-source")).toContainText("Pre-recorded run");
    await expect(page.locator("#reasoning .reasoning")).toHaveCount(10);
    await expect(page.locator("#reasoning .reasoning.is-fallback")).toHaveCount(4);
    await expect(page.locator("#lesson")).toContainText("Why confident reasoning didn't translate");
  });

  test("switches to the recording's own settings when they differ", async ({ page }) => {
    await noWorker(page);
    await page.goto(race("seed=mismatch&radius=6&s=random,llm"));
    await runRace(page);
    await expect(page.locator("#reasoning-source")).toContainText("settings switched");
    await expect(page.getByLabel("Max mutations from current best")).toHaveValue("3");
    await expect(page).toHaveURL(/radius=3/);
  });

  test.describe("live", () => {
    interface Captured {
      sessions: number;
      moves: Record<string, unknown>[];
    }

    async function mockWorker(page: Page, move: (route: Route, n: number) => Promise<void>): Promise<Captured> {
      const captured: Captured = { sessions: 0, moves: [] };
      await page.route("**/turnstile/v0/api.js*", (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: "window.turnstile={render:(el,o)=>{window.__turnstileAction=o.action;setTimeout(()=>o.callback('stub-token'),10);return 'w1'},remove:()=>{}};",
        }),
      );
      await page.route("**/api/config", (route) =>
        route.fulfill({
          json: { llm: { available: true, configured: true, model: "@cf/meta/llama-3.2-3b-instruct", turnstileSiteKey: "1x00000000000000000000AA" } },
        }),
      );
      await page.route("**/api/session", async (route) => {
        captured.sessions++;
        expect(route.request().postDataJSON()).toEqual({ turnstileToken: "stub-token" });
        await route.fulfill({ json: { sessionToken: "session-1", expiresAt: Date.now() + 60_000 } });
      });
      await page.route("**/api/llm-move", async (route) => {
        captured.moves.push(route.request().postDataJSON());
        await move(route, captured.moves.length);
      });
      return captured;
    }

    test("one challenge per run; requests never carry untried brightness", async ({ page }) => {
      const captured = await mockWorker(page, (route) =>
        route.fulfill({ json: { picks: [0, 1, 2, 3, 4], reasoning: "Mock: stay away from the chromophore.", neuronsEstimated: 19 } }),
      );
      await page.goto(race("seed=live&s=random,profile,llm&llm=live"));
      await expect(page.locator("#llm-note")).toContainText("Asks @cf/meta/llama-3.2-3b-instruct live");
      await runRace(page);

      expect(captured.sessions).toBe(1);
      // the Worker rejects siteverify results for any other action
      expect(await page.evaluate(() => (window as unknown as { __turnstileAction?: string }).__turnstileAction)).toBe("llm_session");
      expect(captured.moves).toHaveLength(10);
      for (const [i, body] of captured.moves.entries()) {
        expect(Object.keys(body).sort()).toEqual(["candidates", "currentVariant", "history", "n", "round", "sessionToken"]);
        expect(body.sessionToken).toBe("session-1");
        expect(body.round).toBe(i + 1);
        const candidates = body.candidates as unknown[];
        for (const c of candidates) {
          expect(Array.isArray(c)).toBe(true);
          expect((c as unknown[]).every(Number.isInteger)).toBe(true);
        }
        // history is exactly what this strategy already tried: 5 per earlier round
        expect((body.history as unknown[]).length).toBe(5 * i);
      }
      await expect(page.locator("#reasoning-source")).toContainText("Live answers");
      await expect(page.locator("#reasoning .reasoning-text").first()).toHaveText("Mock: stay away from the chromophore.");
      await expect(page.locator("#reasoning .reasoning.is-fallback")).toHaveCount(0);
    });

    test("falls back to the recorded run when the daily budget is spent", async ({ page }) => {
      await mockWorker(page, (route, n) =>
        n <= 2
          ? route.fulfill({ json: { picks: [0, 1, 2, 3, 4], reasoning: "live", neuronsEstimated: 19 } })
          : route.fulfill({
              status: 503,
              json: { error: { code: "AI_BUDGET_EXHAUSTED", message: "Today's live LLM budget is spent." } },
            }),
      );
      await page.goto(race("seed=budget&s=random,llm&llm=live"));
      await runRace(page);
      await expect(page.locator("#reasoning-source")).toContainText("recorded run");
      await expect(page.locator("#reasoning .reasoning")).toHaveCount(10);
      await expect(page.getByLabel("Recorded run (free)")).toBeChecked();
    });

    test("falls back to the recorded run when the Worker is unavailable", async ({ page }) => {
      await noWorker(page);
      await page.goto(race("seed=nolive&s=random,llm&llm=live"));
      await expect(page.locator("#llm-note")).toContainText("aren't available right now");
      await runRace(page);
      await expect(page.locator("#reasoning-source")).toContainText("this is the recorded run");
    });
  });
});
