/**
 * @fileoverview Real-Chromium coverage for the rail's Projects block: a long list is
 * capped to about three rows with its own scroll, its heading folds it (remembered per
 * device, count shown when folded), and the session list stays on screen at any height.
 *
 * Loads the shipped #tabRail markup, styles.css and projects.js (the rail renderer).
 * Port: none (page.route on a fake origin, no server).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

const RAIL_HTML = (() => {
  const dom = new JSDOM(read('index.html'));
  const html = dom.window.document.getElementById('tabRail')!.outerHTML;
  dom.window.close();
  return html;
})();

async function setup(browser: Browser, height: number, projects: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height }, deviceScaleFactor: 1 });
  await page.route('http://codeman.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
  );
  await page.goto('http://codeman.test/');
  await page.setContent(`<!doctype html>
    <html data-tab-orientation="vertical">
      <head><style>${read('styles.css')}</style></head>
      <body><main class="main" style="display:flex;width:100%;height:${height}px;overflow:hidden">${RAIL_HTML}</main></body>
    </html>`);
  await page.evaluate(() => {
    const tabs = document.createElement('div');
    tabs.id = 'sessionTabs';
    tabs.className = 'session-tabs';
    for (let i = 0; i < 3; i++) {
      const t = document.createElement('div');
      t.className = 'session-tab';
      t.textContent = `session ${i}`;
      t.style.height = '32px';
      tabs.appendChild(t);
    }
    const rail = document.getElementById('tabRail')!;
    rail.insertBefore(tabs, document.getElementById('tabRailResizeHandle'));
  });
  await page.addScriptTag({
    content:
      'function CodemanApp() {}\n' +
      read('projects.js') +
      '\nwindow.__app = new CodemanApp();\nwindow.__App = CodemanApp;',
  });
  await page.evaluate((n) => {
    const app = (window as any).__app;
    app._projects = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`,
      name: `Project ${i + 1}`,
      target: 'local',
      path: `/tmp/p${i}`,
      mode: 'claude',
    }));
    app.renderProjectRail();
  }, projects);
  return page;
}

const visibleSessionRows = (page: Page) =>
  page.evaluate(() => {
    const rail = document.getElementById('tabRail')!.getBoundingClientRect();
    return [...document.querySelectorAll('#tabRail .session-tab')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.height > 0 && r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1;
    }).length;
  });

describe('rail Projects block in Chromium', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  for (const height of [600, 900]) {
    for (const n of [2, 8, 30]) {
      it(`keeps every session row visible at ${height}px with ${n} projects`, async () => {
        const page = await setup(browser, height, n);
        expect(await visibleSessionRows(page)).toBe(3);
        const listH = await page.evaluate(
          () => document.getElementById('tabRailProjectsList')!.getBoundingClientRect().height
        );
        expect(listH).toBeLessThanOrEqual(140);
        await page.close();
      });
    }
  }

  it('folds from the heading, shows the count, and remembers the choice', async () => {
    const page = await setup(browser, 700, 30);
    const toggle = page.locator('#tabRailProjectsToggle');
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    await toggle.click();
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    expect(await page.locator('#tabRailProjectsList').isHidden()).toBe(true);
    expect(await toggle.textContent()).toContain('(30)');
    expect(await page.evaluate(() => localStorage.getItem('codeman:rail-projects-collapsed'))).toBe('1');
    // A fresh render (as after a reload) comes back folded.
    await page.evaluate(() => (window as any).__app.renderProjectRail());
    expect(await page.locator('#tabRailProjectsToggle').getAttribute('aria-expanded')).toBe('false');
    await page.close();
  });

  it('a window too short for everything scrolls the rail, with the sessions reachable', async () => {
    const page = await setup(browser, 380, 30);
    const scrolls = await page.evaluate(() => {
      const r = document.getElementById('tabRail')!;
      return r.scrollHeight > r.clientHeight;
    });
    expect(scrolls).toBe(true);
    await page.evaluate(() => {
      document.getElementById('tabRail')!.scrollTop = 9999;
    });
    expect(await visibleSessionRows(page)).toBe(3);
    await page.close();
  });
});
