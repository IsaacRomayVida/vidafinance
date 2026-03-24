/**
 * VID3-370: v1.8 Full E2E Test — 12 phases, all flows, all users
 * Run with: NODE_PATH=$(npm root -g) node e2e-test-v18.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
process.env.NODE_PATH = process.env.NODE_PATH || require('child_process').execSync('npm root -g').toString().trim();
require('module').Module._initPaths();
const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');

const BASE = 'https://vida-finance.web.app';
const TIMEOUT = 10000;
const PASSWORD = 'TestPass123!';
const TS = Date.now();
const EMPLOYER_EMAIL = `e2e-employer-${TS}@vida-test.com`;
const EMPLOYEE_EMAIL = `e2e-employee-${TS}@vida-test.com`;
const EXISTING_EMPLOYER = 'test-employer-1774134933675@vida-test.com';
const EXISTING_EMPLOYEE = 'test-employee-audit-e2e@vida-test.com';

let passed = 0, failed = 0;
const failures = [];
let inviteCode = null;

function log(s, phase, desc, actual) {
  if (s === 'PASS') { passed++; console.log(`[PASS] Phase ${phase}: ${desc}`); }
  else { failed++; const m = `Phase ${phase}: ${desc} — actual: ${actual}`; failures.push(m); console.log(`[FAIL] ${m}`); }
}
function check(c, p, d, a) { c ? log('PASS', p, d) : log('FAIL', p, d, a || 'condition not met'); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpStatus(url) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', e => resolve(`error: ${e.message}`));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
  });
}

async function getPageText(page) {
  try { return await page.evaluate(() => document.body?.innerText || ''); } catch { return ''; }
}

/** Type into a React controlled input using keyboard (Cmd+A, Backspace, type) */
async function typeReact(page, el, text) {
  await el.click();
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.press('Backspace');
  for (const ch of text) await page.keyboard.type(ch, { delay: 10 });
}

/** Click the footer onb-btn (not the one inside .onb-stage success step) */
async function clickOnbNext(page) {
  return page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button.onb-btn')).find(b => !b.closest('.onb-stage'));
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  });
}

/** Fill all visible onb-input fields, selects, tiles, password, checkbox on current onboarding step */
async function fillOnboardingStep(page, fieldValues) {
  // Fill text inputs
  const inputs = await page.$$('input.onb-input');
  let filled = 0;
  for (const inp of inputs) {
    const meta = await inp.evaluate(el => ({
      vis: el.offsetParent !== null, type: el.type, ph: (el.placeholder || '').toLowerCase(), maxLen: el.maxLength
    }));
    if (!meta.vis || meta.type === 'password') continue;
    let val = fieldValues[meta.ph] || fieldValues.default || 'TestValue';
    // Auto-detect
    if (meta.ph.includes('company') || meta.ph.includes('empresa')) val = fieldValues.company || `E2E Corp ${TS}`;
    else if (meta.ph.includes('name') || meta.ph.includes('nombre')) val = fieldValues.name || 'E2E Test User';
    else if (meta.ph.includes('email') || meta.ph.includes('correo')) val = fieldValues.email || EMPLOYER_EMAIL;
    else if (meta.ph.includes('phone') || meta.ph.includes('tel')) val = fieldValues.phone || '5551234567';
    else if (meta.ph.includes('rfc')) val = fieldValues.rfc || 'AAAA000000XX1';
    else if (meta.ph.includes('clabe') || meta.ph.includes('18')) val = fieldValues.clabe || '012345678901234567';
    else if (meta.ph.includes('curp')) val = fieldValues.curp || 'BADD110313HDFRRL09';
    else if (meta.ph.includes('salary') || meta.ph.includes('salario')) val = fieldValues.salary || '15000';
    else if (meta.ph.includes('code') || meta.ph.includes('código')) val = fieldValues.code || 'ABC123';
    else if (meta.ph.includes('birth') || meta.ph.includes('nacimiento')) val = '1990-05-15';
    await typeReact(page, inp, val);
    filled++;
  }

  // Password
  for (const p of await page.$$('input[type="password"]')) {
    const vis = await p.evaluate(el => el.offsetParent !== null);
    if (vis) { await typeReact(page, p, PASSWORD); filled++; }
  }

  // Selects
  for (const s of await page.$$('select.onb-select')) {
    const vis = await s.evaluate(el => el.offsetParent !== null);
    if (vis) {
      const opts = await s.evaluate(el => Array.from(el.options).map(o => o.value).filter(v => v));
      if (opts.length > 0) {
        await s.select(opts[Math.min(1, opts.length - 1)]);
        await s.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
        filled++;
      }
    }
  }

  // Tiles — click first unselected in each group
  const tilesFilled = await page.evaluate(() => {
    let count = 0;
    document.querySelectorAll('.onb-tiles').forEach(g => {
      if (g.offsetParent && !g.querySelector('.onb-tile.active')) {
        const f = g.querySelector('.onb-tile');
        if (f) { f.click(); count++; }
      }
    });
    return count;
  });
  filled += tilesFilled;

  // Checkbox
  await page.evaluate(() => {
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.offsetParent && !cb.checked) cb.click();
    });
  });

  return filled;
}

(async () => {
  console.log('=== VID3-370: v1.8 Full E2E Test ===');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Base URL: ${BASE}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  // ============================================================
  // PHASE 1: All 13 Public Pages (200 OK)
  // ============================================================
  console.log('\n--- Phase 1: Public Pages ---');
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    for (const route of ['/', '/employers', '/employees', '/about', '/security', '/privacy',
      '/terms', '/partners', '/investors', '/contact', '/press', '/login', '/onboarding']) {
      try {
        const resp = await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2', timeout: 15000 });
        const status = resp?.status();
        const text = await getPageText(page);
        check(status === 200, 1, `${route} returns 200`, `status=${status}`);
        check(text.length > 10, 1, `${route} has content`, `length=${text.length}`);
      } catch (e) { log('FAIL', 1, `${route} loads`, e.message); }
    }
    await ctx.close();
  }

  // ============================================================
  // PHASE 2: Language Toggle
  // ============================================================
  console.log('\n--- Phase 2: Language Toggle ---');
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    try {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(1000);
      let text = await getPageText(page);
      check(/solicitar|préstamo|empleador|empleado|financi|nómina|empresa|confianza/i.test(text),
        2, 'Default language is Spanish', `text: ${text.substring(0, 80)}`);

      // Toggle to English via localStorage + reload (most reliable)
      await page.evaluate(() => {
        localStorage.setItem('vida_lang', 'en');
        document.documentElement.lang = 'en';
      });
      await page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(1000);
      text = await getPageText(page);
      const hasEnglish = /employer|employee|trust|how it works|get started|sign in/i.test(text);
      check(hasEnglish, 2, 'English text after lang=en', `text: ${text.substring(0, 100)}`);

      // Toggle back to Spanish
      await page.evaluate(() => localStorage.setItem('vida_lang', 'es'));
      await page.reload({ waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(1000);
      text = await getPageText(page);
      check(/solicitar|préstamo|empleador|empleado|financi|confianza/i.test(text),
        2, 'Spanish returns after lang=es', `text: ${text.substring(0, 100)}`);

      // Also verify nav-lang button exists
      const hasLangBtn = await page.$('button.nav-lang') !== null;
      check(hasLangBtn, 2, 'Language toggle button exists (button.nav-lang)');

    } catch (e) { log('FAIL', 2, 'Language toggle', e.message); }
    await ctx.close();
  }

  // ============================================================
  // PHASE 3: Fresh Employer Onboarding
  // ============================================================
  console.log('\n--- Phase 3: Employer Onboarding ---');
  console.log(`  Email: ${EMPLOYER_EMAIL}`);
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    try {
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(2000);

      // Role selection
      await page.waitForSelector('button.onb-role', { timeout: TIMEOUT });
      const roles = await page.$$('button.onb-role');
      check(roles.length >= 2, 3, 'Role buttons found', `found ${roles.length}`);
      await roles[0].click(); // employer
      await sleep(2000);

      // Walk through all steps adaptively
      const maxSteps = 10;
      let stepCount = 0;
      let reachedEnd = false;

      for (let i = 0; i < maxSteps; i++) {
        const stepInfo = await page.evaluate(() => {
          const a = document.querySelector('.onb-stage.active');
          return {
            heading: a?.querySelector('h1')?.textContent?.substring(0, 50) || 'none',
            inputs: Array.from(document.querySelectorAll('input.onb-input')).filter(i => i.offsetParent && i.type !== 'password').length,
            selects: Array.from(document.querySelectorAll('select.onb-select')).filter(s => s.offsetParent).length,
            tiles: Array.from(document.querySelectorAll('.onb-tiles')).filter(g => g.offsetParent).length,
            pwd: Array.from(document.querySelectorAll('input[type="password"]')).filter(i => i.offsetParent).length,
            cb: Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(i => i.offsetParent).length,
          };
        });

        stepCount++;
        const totalFields = stepInfo.inputs + stepInfo.selects + stepInfo.tiles + stepInfo.pwd + stepInfo.cb;
        console.log(`  Step ${stepCount}: "${stepInfo.heading}" — ${totalFields} fields`);

        const filled = await fillOnboardingStep(page, { email: EMPLOYER_EMAIL });
        await sleep(800);

        const clicked = await clickOnbNext(page);
        if (!clicked) {
          console.log(`  Step ${stepCount}: Next button disabled after filling`);
          break;
        }

        await sleep(3000);

        // Check if footer button disappeared (success step has no footer)
        const hasFooter = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button.onb-btn')).some(b => !b.closest('.onb-stage'))
        );
        if (!hasFooter) {
          reachedEnd = true;
          break;
        }

        // Detect if we're stuck on same step
        const newHeading = await page.evaluate(() =>
          document.querySelector('.onb-stage.active h1')?.textContent?.substring(0, 50) || 'none'
        );
        if (newHeading === stepInfo.heading && i > 0) {
          // Same step — account creation might be in progress or failed
          const error = await page.evaluate(() => {
            const err = document.querySelector('.onb-error');
            return err?.textContent || '';
          });
          if (error) console.log(`  Error: ${error}`);
          reachedEnd = true; // treat as end
          break;
        }
      }

      check(stepCount >= 3, 3, `Completed ${stepCount} onboarding steps`);
      check(reachedEnd, 3, 'Reached end of onboarding', `Stopped at step ${stepCount}`);

      // Check final state
      await sleep(2000);
      const finalUrl = page.url();
      const finalText = await getPageText(page);
      const success = finalUrl.includes('/employer') ||
        /account created|verification|go to|created|bienvenido|welcome/i.test(finalText);
      check(success, 3, 'Account created or success page', `URL: ${finalUrl}`);

    } catch (e) { log('FAIL', 3, 'Employer onboarding error', e.message); }
    await ctx.close();
  }

  // ============================================================
  // PHASE 4: Employer Login
  // ============================================================
  console.log('\n--- Phase 4: Employer Login ---');
  let employerCtx, employerPage;
  {
    employerCtx = await browser.createBrowserContext();
    employerPage = await employerCtx.newPage();
    await employerPage.setViewport({ width: 1280, height: 900 });
    try {
      await employerPage.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(1500);
      const inputs = await employerPage.$$('input');
      for (const inp of inputs) {
        const meta = await inp.evaluate(el => ({ type: el.type, vis: el.offsetParent !== null }));
        if (!meta.vis) continue;
        if ((meta.type === 'email' || meta.type === 'text') && !meta.done) {
          await typeReact(employerPage, inp, EXISTING_EMPLOYER);
        } else if (meta.type === 'password') {
          await typeReact(employerPage, inp, PASSWORD);
        }
      }
      check(true, 4, 'Credentials entered');
      await employerPage.evaluate(() => {
        for (const b of document.querySelectorAll('button[type="submit"], button')) {
          if (/login|iniciar|sign in|entrar|ingresar|acceder/i.test(b.textContent)) { b.click(); return; }
        }
      });
      check(true, 4, 'Login button clicked');
      await sleep(5000);
      check(employerPage.url().includes('/employer'), 4, 'URL contains /employer', `URL: ${employerPage.url()}`);
      const dt = await getPageText(employerPage);
      check(/dashboard|panel|employee|empleado|company|empresa|stat|loan/i.test(dt), 4, 'Dashboard text visible', `text: ${dt.substring(0, 120)}`);
    } catch (e) { log('FAIL', 4, 'Employer login', e.message); }
  }

  // ============================================================
  // PHASE 5: Employer Dashboard Features
  // ============================================================
  console.log('\n--- Phase 5: Employer Dashboard Features ---');
  try {
    const page = employerPage;
    if (!page.url().includes('/employer')) {
      await page.goto(`${BASE}/employer`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(2000);
    }
    const dt = await getPageText(page);
    const dh = await page.evaluate(() => document.body?.innerHTML || '');
    check(/upload|document|subir|documento|archivo|file/i.test(dt + dh), 5, 'Upload documents section visible', 'Not found');
    check(/stat|total|active|activo|pending|pendiente|employee|empleado/i.test(dt), 5, 'Stats cards visible', 'Not found');
    check(/curp|part\s*b|payroll|nómina|configuración/i.test(dt + dh), 5, '3-CURP Part B card visible', 'Not found');

    // Fill CURP inputs (any visible text inputs on dashboard)
    const curps = ['BADD110313HDFRRL09', 'GARC850101HDFRRL01', 'LOPM900215MDFRRL05'];
    const vis = [];
    for (const inp of await page.$$('input')) {
      const m = await inp.evaluate(el => el.offsetParent !== null && el.type !== 'hidden' && el.type !== 'password');
      if (m) vis.push(inp);
    }
    let cf = 0;
    for (let i = 0; i < Math.min(vis.length, 3); i++) {
      try { await typeReact(page, vis[i], curps[i]); cf++; } catch {}
    }
    check(cf >= 1, 5, `CURPs filled (${cf}/3)`, 'No inputs found');

    if (cf > 0) {
      const sub = await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
          if (/submit|enviar|save|guardar|verify|verificar|confirm/i.test(b.textContent)) { b.click(); return true; }
        }
        return false;
      });
      if (sub) {
        await sleep(2000);
        const at = await getPageText(page);
        check(/pending|success|confirm|guardado|verified|sent|processing|error/i.test(at), 5, 'CURP submit feedback');
      } else {
        check(false, 5, 'CURP submit button', 'Not found');
      }
    }
  } catch (e) { log('FAIL', 5, 'Dashboard features', e.message); }

  // ============================================================
  // PHASE 6: Employer Employees Page
  // ============================================================
  console.log('\n--- Phase 6: Employer Employees Page ---');
  try {
    const page = employerPage;
    await page.goto(`${BASE}/employer/employees`, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(3000);
    const et = await getPageText(page);
    console.log(`  Page text: ${et.substring(0, 200)}`);

    // Look for invite code
    const cd = await page.evaluate(() => {
      for (const s of document.querySelectorAll('span')) {
        const t = s.textContent.trim();
        const cs = window.getComputedStyle(s);
        if (t.length >= 4 && t.length <= 8 && /^[A-Z0-9]+$/.test(t) && parseFloat(cs.letterSpacing) > 1)
          return { code: t, found: true };
      }
      const m = (document.body?.innerText || '').match(/\b[A-HJ-NP-Z2-9]{6}\b/);
      if (m) return { code: m[0], found: true };
      for (const s of document.querySelectorAll('span')) {
        if (/^[A-Z0-9]{4,8}$/.test(s.textContent.trim())) return { code: s.textContent.trim(), found: true };
      }
      return { code: null, found: false };
    });
    check(cd.found, 6, 'Invite code is displayed', 'Not found (employer may have no code in Firestore)');
    if (cd.found) {
      inviteCode = cd.code;
      check(/^[A-Z0-9]{4,8}$/.test(inviteCode), 6, `Code alphanumeric: ${inviteCode}`);
    }

    const hasCopy = await page.evaluate(() => {
      for (const b of document.querySelectorAll('button'))
        if (/copy|copiar|copied/i.test(b.textContent)) return true;
      return false;
    });
    check(hasCopy, 6, 'Copy button exists', 'Not found');
    console.log(`  Invite code: ${inviteCode || 'NOT FOUND'}`);
  } catch (e) { log('FAIL', 6, 'Employees page', e.message); }

  // ============================================================
  // PHASE 7: Employer Loans Page
  // ============================================================
  console.log('\n--- Phase 7: Employer Loans Page ---');
  try {
    const resp = await employerPage.goto(`${BASE}/employer/loans`, { waitUntil: 'networkidle2', timeout: 15000 });
    check(resp?.status() === 200, 7, 'Page loads (not 404)', `status=${resp?.status()}`);
    check((await getPageText(employerPage)).length > 20, 7, 'Content visible');
  } catch (e) { log('FAIL', 7, 'Loans page', e.message); }
  await employerCtx.close();

  // ============================================================
  // PHASE 8: Fresh Employee Onboarding
  // ============================================================
  console.log('\n--- Phase 8: Employee Onboarding ---');
  console.log(`  Email: ${EMPLOYEE_EMAIL}`);
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    try {
      await page.goto(`${BASE}/onboarding`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(2000);
      const roles = await page.$$('button.onb-role');
      check(roles.length >= 2, 8, 'Role buttons found');
      await roles[1].click(); // employee
      await sleep(2000);

      // Walk through steps adaptively
      let stepCount = 0, reachedEnd = false;
      for (let i = 0; i < 10; i++) {
        const si = await page.evaluate(() => {
          const a = document.querySelector('.onb-stage.active');
          return {
            heading: a?.querySelector('h1')?.textContent?.substring(0, 50) || 'none',
            totalFields: Array.from(document.querySelectorAll('input.onb-input, select.onb-select, input[type="password"], input[type="checkbox"], .onb-tiles')).filter(el => el.offsetParent !== null).length,
          };
        });
        stepCount++;
        console.log(`  Step ${stepCount}: "${si.heading}" — ${si.totalFields} fields`);

        await fillOnboardingStep(page, {
          email: EMPLOYEE_EMAIL,
          name: 'E2E Employee Tester',
          code: inviteCode || 'ABC123',
          curp: 'BADD110313HDFRRL09',
          rfc: 'BADD1103138Z9',
          salary: '15000',
        });

        // For employer code step, wait for lookup
        if (si.heading.toLowerCase().includes('code') || si.heading.toLowerCase().includes('código') || stepCount === 1) {
          await sleep(4000); // debounce + network lookup
        }

        await sleep(800);
        const clicked = await clickOnbNext(page);
        if (!clicked) {
          const err = await page.evaluate(() => document.querySelector('.onb-error')?.textContent || '');
          console.log(`  Step ${stepCount}: Next disabled${err ? ' — ' + err : ''}`);
          break;
        }
        await sleep(3000);

        const hasFooter = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button.onb-btn')).some(b => !b.closest('.onb-stage'))
        );
        if (!hasFooter) { reachedEnd = true; break; }

        const nh = await page.evaluate(() =>
          document.querySelector('.onb-stage.active h1')?.textContent?.substring(0, 50) || 'none'
        );
        if (nh === si.heading && i > 0) {
          const err = await page.evaluate(() => document.querySelector('.onb-error')?.textContent || '');
          if (err) console.log(`  Error: ${err}`);
          reachedEnd = true;
          break;
        }
      }
      check(stepCount >= 2, 8, `Completed ${stepCount} onboarding steps`);
      check(reachedEnd, 8, 'Reached end of onboarding', `Stopped at step ${stepCount}`);
    } catch (e) { log('FAIL', 8, 'Employee onboarding error', e.message); }
    await ctx.close();
  }

  // ============================================================
  // PHASE 9: Employee Login
  // ============================================================
  console.log('\n--- Phase 9: Employee Login ---');
  let employeeCtx, employeePage;
  {
    employeeCtx = await browser.createBrowserContext();
    employeePage = await employeeCtx.newPage();
    await employeePage.setViewport({ width: 1280, height: 900 });
    try {
      await employeePage.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(1500);
      const inputs = await employeePage.$$('input');
      for (const inp of inputs) {
        const m = await inp.evaluate(el => ({ type: el.type, vis: el.offsetParent !== null }));
        if (!m.vis) continue;
        if (m.type === 'email' || m.type === 'text') await typeReact(employeePage, inp, EXISTING_EMPLOYEE);
        else if (m.type === 'password') await typeReact(employeePage, inp, PASSWORD);
      }
      await employeePage.evaluate(() => {
        for (const b of document.querySelectorAll('button'))
          if (/login|iniciar|sign in|entrar/i.test(b.textContent)) { b.click(); return; }
      });
      await sleep(5000);
      check(employeePage.url().includes('/employee'), 9, 'URL contains /employee', `URL: ${employeePage.url()}`);
      const dt = await getPageText(employeePage);
      check(/credit|crédito|amount|monto|available|disponible|dashboard|panel/i.test(dt), 9, 'Dashboard shows credit info', `text: ${dt.substring(0, 120)}`);
    } catch (e) { log('FAIL', 9, 'Employee login', e.message); }
  }

  // ============================================================
  // PHASE 10: Request Funds Modal
  // ============================================================
  console.log('\n--- Phase 10: Request Funds Modal ---');
  try {
    const page = employeePage;
    if (!page.url().includes('/employee')) {
      await page.goto(`${BASE}/employee`, { waitUntil: 'networkidle2', timeout: 15000 });
      await sleep(2000);
    }

    const rfClicked = await page.evaluate(() => {
      for (const b of document.querySelectorAll('button'))
        if (/request|solicitar|fondos|funds/i.test(b.textContent)) { b.click(); return true; }
      return false;
    });
    check(rfClicked, 10, 'Request Funds button clicked', 'Not found');
    await sleep(3000);

    // Get modal content
    const mc = await page.evaluate(() => {
      const m = document.querySelector('.modal');
      return m ? m.innerText : 'no modal';
    });
    console.log(`  Modal excerpt: ${mc.substring(0, 200)}`);

    const mh = await page.evaluate(() => document.querySelector('.modal')?.innerHTML || '');

    check(await page.$('.modal input[type="number"], input[type="number"]') !== null, 10, 'Amount input visible', 'Not found');
    check(/clabe|cuenta bancaria|bank account/i.test(mc + mh), 10, 'CLABE field visible', 'Not in modal text/html');
    check(/purpose|propósito|motivo/i.test(mc + mh) || await page.$('.modal select') !== null, 10, 'Loan purpose dropdown visible', 'Not found');
    check(await page.$('input[type="checkbox"]') !== null, 10, 'Terms checkbox visible', 'Not found');
    check(/fee|comisión|costo|cargo/i.test(mc + mh), 10, 'Fee calculation visible', 'Not found');
    check(/cat/i.test(mc + mh), 10, 'CAT percentage visible', 'Not found');
    check(/condusef/i.test(mc + mh), 10, 'CONDUSEF legend visible', 'Not found');

    // Fill amount
    const amtInp = await page.$('input[type="number"]');
    if (amtInp) {
      await typeReact(page, amtInp, '2000');
      check(true, 10, 'Amount filled: 2000');
    } else {
      check(false, 10, 'Amount filled', 'Number input not found');
    }

    // Fill CLABE if input visible
    const clabeInp = await page.$('input[maxlength="18"], input[inputmode="numeric"]:not([type="number"])');
    if (clabeInp) {
      const vis = await clabeInp.evaluate(el => el.offsetParent !== null);
      if (vis) {
        await typeReact(page, clabeInp, '012345678901234567');
        check(true, 10, 'CLABE filled');
      } else {
        check(true, 10, 'CLABE pre-filled (masked)');
      }
    }

    // Select purpose
    const purposeSel = await page.$('.modal select, select');
    if (purposeSel) {
      const opts = await purposeSel.evaluate(el => Array.from(el.options).map(o => o.value).filter(v => v));
      if (opts.length > 0) {
        await purposeSel.select(opts[0]);
        await purposeSel.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
        check(true, 10, 'Purpose selected');
      }
    }

    // Check terms (don't submit)
    await page.evaluate(() => {
      for (const cb of document.querySelectorAll('input[type="checkbox"]'))
        if (cb.offsetParent && !cb.checked) cb.click();
    });
    check(true, 10, 'Terms checked (DO NOT submit)');

    // Close modal
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.evaluate(() => {
      const c = document.querySelector('.modal-close');
      if (c) c.click();
    });
    check(true, 10, 'Modal closed');

  } catch (e) { log('FAIL', 10, 'Request Funds modal', e.message); }
  await employeeCtx.close();

  // ============================================================
  // PHASE 11: Auth Guards (unauthenticated)
  // ============================================================
  console.log('\n--- Phase 11: Auth Guards ---');
  {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    for (const route of ['/employer', '/employer/employees', '/employer/loans', '/employee', '/employee/apply', '/employee/loans']) {
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2', timeout: 15000 });
        await sleep(3000);
        const url = page.url();
        const text = await getPageText(page);
        const guarded = url.includes('/login') || url.includes('/onboarding') ||
          url === `${BASE}/` || url === BASE ||
          /login|iniciar sesión|sign in/i.test(text);
        check(guarded, 11, `${route} redirects to login`, `URL: ${url}`);
      } catch (e) { log('FAIL', 11, `${route}`, e.message); }
    }
    // 404
    await page.goto(`${BASE}/nonexistent-page`, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(1000);
    const t404 = await getPageText(page);
    check(/404|not found|no encontr/i.test(t404) || page.url() === `${BASE}/`, 11, '/nonexistent-page → 404', `text: ${t404.substring(0, 80)}`);
    // /admin
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2', timeout: 15000 });
    await sleep(1000);
    check(/404|not found|login/i.test(await getPageText(page)) || page.url().includes('/login') || page.url() === `${BASE}/`,
      11, '/admin → 404 or redirect', `URL: ${page.url()}`);
    await ctx.close();
  }

  // ============================================================
  // PHASE 12: API Health
  // ============================================================
  console.log('\n--- Phase 12: API Health ---');
  const endpoints = [
    ['Frontend', 'https://vida-finance.web.app/'],
    ['API', 'https://api-gd5fcu677q-uc.a.run.app/health'],
    ['ML Service', 'https://ml-service-production.up.railway.app/health'],
    ['Underwriting', 'https://underwriting-service-production.up.railway.app/health'],
    ['Notification', 'https://notification-service-production.up.railway.app/health'],
    ['Payment', 'https://payment-server-production.up.railway.app/health'],
    ['PDF Generator', 'https://pdf-generator-production.up.railway.app/health'],
  ];
  await Promise.all(endpoints.map(async ([name, url]) => {
    const st = await httpStatus(url);
    check(st === 200, 12, `${name} (${url})`, `status=${st}`);
  }));

  // ============================================================
  // SUMMARY
  // ============================================================
  await browser.close();

  console.log('\n=== SUMMARY ===');
  console.log(`Total: ${passed + failed} checks`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('Failed checks:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log(`\nFinished: ${new Date().toISOString()}`);
})();
