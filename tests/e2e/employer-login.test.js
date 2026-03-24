const puppeteer = require('puppeteer');

const APP_URL = process.env.E2E_APP_URL || 'https://vida-finance.web.app';
const TEST_EMAIL = process.env.E2E_EMPLOYER_EMAIL || 'test-employer-1774134933675@vida-test.com';
const TEST_PASSWORD = process.env.E2E_EMPLOYER_PASSWORD || 'TestPass123!';

// Use system Chrome if Puppeteer's bundled Chromium is unavailable
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

describe('Employer login (clean env)', () => {
  let browser;
  let page;

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

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (page) await page.close();
  });

  it('should login as employer and redirect to /employer', async () => {
    const navLog = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navLog.push(frame.url());
    });

    // Navigate to login page
    await page.goto(`${APP_URL}/login`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });

    // Fill in credentials
    await page.type('input[type="email"]', TEST_EMAIL);
    await page.type('input[type="password"]', TEST_PASSWORD);

    // Submit login form
    await page.click('button[type="submit"]');

    // Wait for navigation to employer dashboard
    await page.waitForFunction(
      () => window.location.pathname.startsWith('/employer'),
      { timeout: 30000 },
    );

    const url = page.url();
    expect(url).toContain('/employer');

    // Verify page loaded with content (not an error page)
    const bodyText = await page.evaluate(() =>
      document.body.innerText.substring(0, 400),
    );
    expect(bodyText).toBeTruthy();

    // Log navigation trail for debugging
    console.log('[NAV LOG]', navLog);
    console.log('[FINAL URL]', url);
  });
});
