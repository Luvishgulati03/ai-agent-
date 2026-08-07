// Portfolio screenshot capture. Run from the henry repo root (Playwright lives here):
//   cd ~/dev/henry && node scripts/portfolio-shots.mjs
// Writes 1440x900 desktop + 390x844 mobile, dark + light, hero + full, at 2x DPR.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const PAGE = "file:///Users/luvishgulati/dev/portfolio/index.html";
const OUT = "/Users/luvishgulati/dev/portfolio/shots";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const browser = await chromium.launch();
const errors = [];

for (const [device, viewport] of Object.entries(VIEWPORTS)) {
  for (const scheme of ["dark", "light"]) {
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      isMobile: device === "mobile",
      hasTouch: device === "mobile",
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${device}/${scheme} ${e}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${device}/${scheme} ${m.text()}`));
    await page.goto(PAGE, { waitUntil: "load" });
    await page.waitForTimeout(1400);

    // hero: viewport only, top of page
    await page.screenshot({ path: `${OUT}/${device}-${scheme}-hero.png` });

    // full: warm up every scroll-reveal, finish the terminal, neutralise the sticky nav
    await page.evaluate(async () => {
      document.documentElement.style.scrollBehavior = "auto";
      const step = Math.round(window.innerHeight * 0.6);
      for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 140));
      }
      await new Promise((r) => setTimeout(r, 400));
      window.scrollTo(0, 0);
    });
    const stillHidden = await page.$$eval(".reveal:not(.in)", (e) => e.length);
    if (stillHidden) throw new Error(`${device}/${scheme}: ${stillHidden} reveals never fired`);

    // terminal: skip to the finished transcript (IO may have restarted playback)
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => document.getElementById("t-skip").click());
      await page.waitForTimeout(500);
      if ((await page.$$eval(".t-line.hid", (e) => e.length)) === 0) break;
    }
    const hidLines = await page.$$eval(".t-line.hid", (e) => e.length);
    if (hidLines) throw new Error(`${device}/${scheme}: terminal transcript incomplete`);

    await page.addStyleTag({ content: ".nav{position:absolute!important;top:0;left:0;right:0;}" });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${device}-${scheme}-full.png`, fullPage: true });

    await ctx.close();
  }
}

await browser.close();
if (errors.length) {
  console.log("CONSOLE/PAGE ERRORS:", errors);
  process.exit(1);
}
console.log("shots written to", OUT);
