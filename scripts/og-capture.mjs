// Portfolio capture + acceptance audit.
// Uses the Playwright already installed in ~/dev/henry — nothing is installed in portfolio/.
//   node scripts/og-capture.mjs            → og.png + screenshots + audit
//   node scripts/og-capture.mjs --audit    → audit only
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const PORTFOLIO = '/Users/luvishgulati/dev/portfolio';
const PAGE = pathToFileURL(path.join(PORTFOLIO, 'index.html')).href;
const CARD = pathToFileURL(path.join(PORTFOLIO, 'assets', 'og-card.html')).href;
const SHOTS = path.join(PORTFOLIO, 'shots');
const auditOnly = process.argv.includes('--audit');

const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch();

/* ---------------- 1. og.png ---------------- */
if (!auditOnly) {
  mkdirSync(path.join(PORTFOLIO, 'assets'), { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.goto(CARD, { waitUntil: 'load' });
  await p.screenshot({ path: path.join(PORTFOLIO, 'assets', 'og.png'), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await ctx.close();
  console.log('wrote assets/og.png (1200x630)');
}

/* ---------------- 2. screenshots ---------------- */
if (!auditOnly) {
  mkdirSync(SHOTS, { recursive: true });
  const viewports = [
    { key: 'desktop', width: 1440, height: 900 },
    { key: 'mobile', width: 390, height: 844 },
  ];
  for (const vp of viewports) {
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        isMobile: vp.key === 'mobile',
        hasTouch: vp.key === 'mobile',
      });
      await ctx.addInitScript(t => localStorage.setItem('lg-theme', t), theme);
      const p = await ctx.newPage();
      await p.goto(PAGE, { waitUntil: 'load' });
      await p.waitForTimeout(500);
      // hero shot (above the fold)
      await p.screenshot({ path: path.join(SHOTS, `${vp.key}-${theme}-hero.png`) });
      // reveal everything, then full page
      await p.evaluate(() => document.querySelectorAll('.reveal').forEach(el => el.classList.add('in')));
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(700);
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.click('#t-skip');
      await p.waitForTimeout(400);
      await p.screenshot({ path: path.join(SHOTS, `${vp.key}-${theme}-full.png`), fullPage: true });
      await ctx.close();
      console.log(`wrote shots/${vp.key}-${theme}-hero.png + -full.png`);
    }
  }
}

/* ---------------- 2b. component inspection (scratchpad, not shipped) ---------------- */
if (process.env.INSPECT) {
  const out = process.env.INSPECT;
  mkdirSync(out, { recursive: true });
  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
    await ctx.addInitScript(t => localStorage.setItem('lg-theme', t), theme);
    const p = await ctx.newPage();
    await p.goto(PAGE, { waitUntil: 'load' });
    await p.evaluate(() => document.querySelectorAll('.reveal').forEach(el => el.classList.add('in')));
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(700);
    await p.click('#t-skip');
    await p.waitForTimeout(300);
    for (const [name, sel] of [['diagram', '.diagram'], ['term', '#term'], ['bento', '.bento'],
      ['dec', '.dec'], ['cases', '#work .wrap'], ['about', '#about .wrap'], ['contact', '#contact .wrap']]) {
      await p.locator(sel).screenshot({ path: path.join(out, `${name}-${theme}.png`) });
    }
    await ctx.close();
  }
  console.log('inspection shots → ' + out);
}

/* ---------------- 3. audit ---------------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const external = [];
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith('file://') && !url.startsWith('data:') && !url.startsWith('about:')) external.push(url);
    route.continue();
  });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
  await p.goto(PAGE, { waitUntil: 'networkidle' });
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await p.waitForTimeout(1200);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.waitForTimeout(300);

  ok('1a. zero console/page errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  ok('1b. zero external requests', external.length === 0, external.slice(0, 4).join(' | '));

  // hero above the fold (desktop) — name, level, target, contact all visible without scrolling
  const heroFits = await p.evaluate(() => {
    const vh = window.innerHeight;
    const sel = ['.eyebrow', 'h1.big', '.sub', '.cta-row a[href^="mailto"]', '.cta-row a[download]'];
    const bad = sel.filter(s => {
      const el = document.querySelector(s);
      if (!el) return true;
      const r = el.getBoundingClientRect();
      return r.bottom > vh || r.top < 0;
    });
    return { bad, scrollY: window.scrollY };
  });
  ok('2a. hero complete above fold @1440x900', heroFits.bad.length === 0, heroFits.bad.join(', '));

  // theme toggle + persistence
  const t0 = await p.getAttribute('html', 'data-theme');
  await p.click('#tt');
  const t1 = await p.getAttribute('html', 'data-theme');
  const stored = await p.evaluate(() => localStorage.getItem('lg-theme'));
  await p.reload({ waitUntil: 'load' });
  const t2 = await p.getAttribute('html', 'data-theme');
  ok('3a. theme toggle flips', t0 !== t1, `${t0} → ${t1}`);
  ok('3b. theme persists across reload', t2 === t1 && stored === t1, `stored=${stored} afterReload=${t2}`);

  // terminal animation + skip
  await p.evaluate(() => document.getElementById('term').scrollIntoView());
  await p.waitForTimeout(900);
  const midway = await p.evaluate(() => document.querySelectorAll('#t-body .t-line.hid').length);
  await p.click('#t-skip');
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => ({
    hidden: document.querySelectorAll('#t-body .t-line.hid').length,
    firstTyped: document.querySelector('#t-body .t-in .txt').textContent.length,
  }));
  ok('4a. terminal types progressively', midway > 0, `${midway} lines still hidden mid-run`);
  ok('4b. skip completes transcript', after.hidden === 0 && after.firstTyped > 20, JSON.stringify(after));

  // links
  const links = await p.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({
    href: a.getAttribute('href'), resolved: a.href, text: a.textContent.trim().slice(0, 34),
    dl: a.hasAttribute('download'),
  })));
  const anchors = await p.evaluate(() => [...document.querySelectorAll('a[href^="#"]')]
    .map(a => a.getAttribute('href')).filter(h => h.length > 1 && !document.querySelector(h)));
  ok('5a. all in-page anchors resolve', anchors.length === 0, anchors.join(', '));
  ok('5b. mailto present', links.some(l => l.href === 'mailto:Gulatiluvish@gmail.com'));
  ok('5c. resume download link present', links.some(l => l.dl && l.href.includes('Luvish_Gulati_Resume.pdf')));
  console.log('\n   external hrefs:');
  [...new Set(links.filter(l => /^https?:/.test(l.href)).map(l => l.href))].forEach(h => console.log('   • ' + h));
  console.log('');

  // page weight
  const weight = await p.evaluate(() => new Blob([document.documentElement.outerHTML]).size);
  ok('6. page weight under 400KB', weight < 400 * 1024, `${(weight / 1024).toFixed(1)} KB (rendered DOM)`);
  await ctx.close();
}

/* reduced motion */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  await p.evaluate(() => document.getElementById('term').scrollIntoView());
  await p.waitForTimeout(350);
  const st = await p.evaluate(() => ({
    hidden: document.querySelectorAll('#t-body .t-line.hid').length,
    typed: document.querySelector('#t-body .t-in .txt').textContent.length,
    revealsHidden: [...document.querySelectorAll('.reveal')].filter(e => getComputedStyle(e).opacity !== '1').length,
    cursor: !!document.querySelector('#t-body .cursor'),
  }));
  ok('4c. reduced-motion renders terminal static + complete',
    st.hidden === 0 && st.typed > 20 && st.revealsHidden === 0 && !st.cursor, JSON.stringify(st));
  await ctx.close();
}

/* mobile: no horizontal scroll, both themes */
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(t => localStorage.setItem('lg-theme', t), theme);
  const p = await ctx.newPage();
  await p.goto(PAGE, { waitUntil: 'load' });
  await p.evaluate(() => document.querySelectorAll('.reveal').forEach(el => el.classList.add('in')));
  await p.waitForTimeout(250);
  const m = await p.evaluate(() => {
    const de = document.documentElement;
    const overflow = [...document.querySelectorAll('body *')]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(el).position !== 'fixed')
      .filter(el => !el.closest('.diagram') && !el.closest('.term-body'))
      .slice(0, 5).map(el => el.tagName + '.' + (el.className || '').toString().split(' ')[0]);
    return { sw: de.scrollWidth, cw: de.clientWidth, overflow };
  });
  ok(`7. mobile no horizontal scroll (${theme})`, m.sw <= m.cw + 1 && m.overflow.length === 0,
    `scrollWidth=${m.sw} clientWidth=${m.cw} ${m.overflow.join(', ')}`);
  // hero fits 390x844
  const heroFits = await p.evaluate(() => {
    const vh = window.innerHeight;
    return ['.eyebrow', 'h1.big', '.sub', '.cta-row a[href^="mailto"]', '.cta-row a[download]']
      .filter(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return !r || r.bottom > vh || r.top < 0; });
  });
  ok(`2b. hero complete above fold @390x844 (${theme})`, heroFits.length === 0, heroFits.join(', '));
  await ctx.close();
}

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map(f => f.name).join('; ')); process.exitCode = 1; }
