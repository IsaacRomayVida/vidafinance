/**
 * Puppeteer audit: crawl the live site and report 404s / failed resource loads.
 * Usage: node scripts/audit-404.mjs [baseUrl]
 */
import puppeteer from 'puppeteer';

const BASE = process.argv[2] || 'https://vida-finance.web.app';
const ROUTES = [
  '/',
  '/services',
  '/about',
  '/contact',
  '/login',
  '/register',
  '/get-started',
  '/onboarding',
  '/forgot-password',
];

const errors = [];

async function auditPage(browser, url) {
  const page = await browser.newPage();
  const pageErrors = [];

  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      pageErrors.push({ url: res.url(), status });
    }
  });

  page.on('requestfailed', (req) => {
    pageErrors.push({ url: req.url(), status: 'FAILED', reason: req.failure()?.errorText });
  });

  try {
    const res = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    const status = res?.status();
    if (status && status >= 400) {
      pageErrors.push({ url, status, note: 'page itself' });
    }
  } catch (e) {
    pageErrors.push({ url, status: 'TIMEOUT/ERROR', reason: e.message });
  }

  await page.close();
  return pageErrors;
}

(async () => {
  console.log(`\n🔍 Auditing ${BASE} ...\n`);
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });

  for (const route of ROUTES) {
    const url = `${BASE}${route}`;
    process.stdout.write(`  ${route} ... `);
    const errs = await auditPage(browser, url);
    if (errs.length) {
      console.log(`❌ ${errs.length} error(s)`);
      errors.push(...errs.map((e) => ({ route, ...e })));
    } else {
      console.log('✅');
    }
  }

  await browser.close();

  console.log('\n' + '='.repeat(60));
  if (errors.length === 0) {
    console.log('✅  ZERO errors — all routes and assets loaded successfully.');
  } else {
    console.log(`❌  ${errors.length} error(s) found:\n`);
    for (const e of errors) {
      console.log(`  [${e.status}] ${e.url}${e.reason ? ` (${e.reason})` : ''} — on route ${e.route}`);
    }
  }
  console.log('='.repeat(60) + '\n');

  process.exit(errors.length > 0 ? 1 : 0);
})();
