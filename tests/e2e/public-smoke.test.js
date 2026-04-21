/**
 * Public marketing / auth E2E smoke suite.
 *
 * Credential-free: every route here is reachable by an anonymous visitor,
 * so this can run in any CI environment (no secrets, no test accounts).
 * Pairs with `employer-login.test.js` (authenticated flow) to give us a
 * baseline regression net: if a deploy breaks the public site or the
 * login entrypoint, we want CI to go red before users see it.
 *
 * Assertions per route (cheap and deliberate):
 *   1. HTTP status < 400 AND the React root mounts (>20 chars of text)
 *   2. No uncaught `pageerror` events (these indicate a JS crash that
 *      breaks interactivity — always a real bug)
 *
 * We intentionally do NOT:
 *   - assert marketing copy — it changes, we don't want typos to red
 *   - fail on `console.error` by default — Firebase App Check and
 *     third-party scripts emit expected noise. Set
 *     `E2E_STRICT_CONSOLE=1` to turn those into failures locally
 *     when investigating regressions.
 */
const puppeteer = require('puppeteer');

const APP_URL = process.env.E2E_APP_URL || 'https://vida-finance.web.app';

// Reuse the same Chrome-path logic as employer-login.test.js.
const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  process.env.CHROME_PATH ||
  (() => {
    const fs = require('fs');
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
    return candidates.find((p) => fs.existsSync(p)) || undefined;
  })();

// Routes that MUST load for an anonymous visitor. If any of these
// breaks, marketing traffic drops and we lose the funnel.
const PUBLIC_ROUTES = [
  { path: '/', label: 'Home' },
  { path: '/employers', label: 'Employers' },
  { path: '/employees', label: 'Employees' },
  { path: '/about', label: 'About' },
  { path: '/security', label: 'Security' },
  { path: '/privacy', label: 'Privacy' },
  { path: '/terms', label: 'Terms' },
  { path: '/contact', label: 'Contact' },
  { path: '/login', label: 'Login' },
  { path: '/onboarding', label: 'Onboarding' },
];

const STRICT_CONSOLE = process.env.E2E_STRICT_CONSOLE === '1';

// Console categories we always ignore, even in strict mode. App Check
// emits info/warn lines on first load, third-party scripts inject
// sourcemap warnings, and extensions are never our concern.
const IGNORED_CONSOLE_PATTERNS = [
  /AppCheck/i,
  /Firestore.*offline/i,
  /source\-?map/i,
  /chrome-extension/i,
];

function shouldIgnoreConsoleMessage(text) {
  return IGNORED_CONSOLE_PATTERNS.some((rx) => rx.test(text));
}

describe('Public site smoke (anonymous)', () => {
  let browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
        '--disable-extensions',
      ],
    });
  });

  afterAll(async () => {
    if (browser) await browser.close();
  });

  for (const { path, label } of PUBLIC_ROUTES) {
    it(`loads ${label} (${path})`, async () => {
      const page = await browser.newPage();
      const pageErrors = [];
      const consoleErrors = [];

      page.on('pageerror', (err) => {
        pageErrors.push(`pageerror: ${err.message}`);
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (shouldIgnoreConsoleMessage(text)) return;
        consoleErrors.push(`console.error: ${text}`);
      });

      try {
        const response = await page.goto(`${APP_URL}${path}`, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        expect(response).not.toBeNull();
        expect(response.status()).toBeLessThan(400);

        // React mounts client-side — <h1> tag varies per route, so we
        // only require that the root React node has rendered something
        // substantive (>20 chars) within the interactive budget.
        await page.waitForFunction(
          () => {
            const root = document.getElementById('root');
            return root && root.textContent && root.textContent.trim().length > 20;
          },
          { timeout: 15000 },
        );

        // Uncaught JS errors are always a real bug: they break
        // interactivity. Fail loudly.
        expect(pageErrors).toEqual([]);

        // Console-level errors are informational unless
        // E2E_STRICT_CONSOLE=1 is set — they often reflect
        // third-party CSP / extension noise.
        if (consoleErrors.length > 0) {
          console.log(`[${label}] console errors (non-fatal):`, consoleErrors);
          if (STRICT_CONSOLE) {
            expect(consoleErrors).toEqual([]);
          }
        }
      } finally {
        await page.close();
      }
    }, 45000);
  }

  it('serves 200 for the root HTML', async () => {
    const page = await browser.newPage();
    try {
      const response = await page.goto(APP_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html).toContain('<div id="root">');
    } finally {
      await page.close();
    }
  }, 30000);
});
