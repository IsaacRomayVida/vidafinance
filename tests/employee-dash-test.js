/**
 * VID3-409 — AUDIT-3b: Employee dashboard + Request Funds modal
 *
 * Puppeteer E2E test covering:
 *   - Login as test employee
 *   - Dashboard element checks
 *   - Request Funds modal field verification
 *   - Fee calculation verification across multiple amounts
 *   - CAT / CONDUSEF display
 *
 * Usage:  node /tmp/employee-dash-test.js
 */

const puppeteer = require('puppeteer');

const BASE = process.env.BASE_URL || 'http://localhost:5000';
const EMAIL = 'test-employee-audit-e2e@vida-test.com';
const PASSWORD = 'TestPass123!';
const VIEWPORT = { width: 1440, height: 900 };
const SCREENSHOT_DIR = '/tmp';
const TIMEOUT = 15_000;

// ── helpers ──────────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function log(status, label, detail = '') {
  const icon = status === 'PASS' ? '✅' : '❌';
  if (status === 'PASS') passCount++;
  else failCount++;
  console.log(`${icon} ${status}: ${label}${detail ? ' — ' + detail : ''}`);
}

async function textExists(page, text) {
  return page.evaluate((t) => document.body.innerText.includes(t), text);
}

async function selectorExists(page, sel) {
  return (await page.$(sel)) !== null;
}

async function screenshot(page, name) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`📸 Screenshot saved: ${path}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  try {
    // ─── 1. LOGIN ──────────────────────────────────────────────────────────────
    console.log('\n═══ STEP 1: LOGIN ═══');
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: TIMEOUT });
    await screenshot(page, '01-login-page');

    // Fill credentials
    const emailInput = await page.$('input[type="email"]');
    const passwordInput = await page.$('input[type="password"]');
    if (!emailInput || !passwordInput) {
      log('FAIL', 'Login form', 'email or password input not found');
      return;
    }
    await emailInput.type(EMAIL, { delay: 30 });
    await passwordInput.type(PASSWORD, { delay: 30 });

    // Submit
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await passwordInput.press('Enter');
    }

    // Wait for redirect to employee dashboard
    await page.waitForFunction(
      (base) => window.location.pathname.startsWith('/employee'),
      { timeout: TIMEOUT },
      BASE
    );
    await sleep(3000); // allow data to load
    await screenshot(page, '02-employee-dashboard');
    log('PASS', 'Login + redirect to employee dashboard');

    // ─── 2. DASHBOARD CHECKS ───────────────────────────────────────────────────
    console.log('\n═══ STEP 2: DASHBOARD CHECKS ═══');

    // Welcome message with employee name
    const headerEl = await page.$('.dash-header h1');
    const headerText = headerEl ? await page.evaluate((el) => el.textContent, headerEl) : '';
    if (headerText && headerText.length > 0) {
      log('PASS', 'Welcome message', headerText.trim());
    } else {
      log('FAIL', 'Welcome message', 'not found');
    }

    // Company name
    const companyEl = await page.$('.dash-user span');
    const companyText = companyEl ? await page.evaluate((el) => el.textContent, companyEl) : '';
    if (companyText && companyText.length > 0) {
      log('PASS', 'Company name displayed', companyText.trim());
    } else {
      log('FAIL', 'Company name displayed');
    }

    // Stat cards
    const statCards = await page.$$('.stat-card');
    const statValues = [];
    for (const card of statCards) {
      const label = await card.$eval('.stat-label', (el) => el.textContent).catch(() => '');
      const value = await card.$eval('.stat-value', (el) => el.textContent).catch(() => '');
      statValues.push({ label, value });
    }

    // Available credit
    const creditCard = statValues.find((s) => s.value && s.value.includes('$'));
    if (creditCard) {
      log('PASS', 'Available credit amount', creditCard.value);
      if (creditCard.value.includes('4,500') || creditCard.value.includes('4500')) {
        log('PASS', 'Available credit = $4,500 MXN');
      } else {
        log('FAIL', 'Available credit = $4,500 MXN', `got ${creditCard.value}`);
      }
    } else {
      log('FAIL', 'Available credit amount');
    }

    // Credit limit
    const limitCard = statValues.length >= 2 ? statValues[1] : null;
    if (limitCard && limitCard.value) {
      log('PASS', 'Credit limit display', limitCard.value);
    } else {
      log('FAIL', 'Credit limit display');
    }

    // Utilization %
    const utilCard = statValues.find((s) => s.value && s.value.includes('%'));
    if (utilCard) {
      log('PASS', 'Utilization percentage', utilCard.value);
      if (utilCard.value.trim() === '0%') {
        log('PASS', 'Utilization = 0% (expected)');
      } else {
        log('FAIL', 'Utilization = 0%', `got ${utilCard.value}`);
      }
    } else {
      log('FAIL', 'Utilization percentage');
    }

    // Request Funds button
    const reqBtn = await page.$('.btn-primary');
    if (reqBtn) {
      const btnText = await page.evaluate((el) => el.textContent, reqBtn);
      log('PASS', 'Request Funds button', btnText.trim());
    } else {
      log('FAIL', 'Request Funds button');
    }

    // Loan history section
    const loanCard = await page.$('.card .card-title');
    if (loanCard) {
      const loanTitle = await page.evaluate((el) => el.textContent, loanCard);
      log('PASS', 'Loan history section', loanTitle.trim());
    } else {
      log('FAIL', 'Loan history section');
    }

    // Empty state or loans
    const emptyState = await page.$('.empty-state');
    const tableWrap = await page.$('.table-wrap');
    if (emptyState) {
      const emptyText = await page.evaluate((el) => el.textContent, emptyState);
      log('PASS', 'Loan empty state ("No loans yet")', emptyText.trim());
    } else if (tableWrap) {
      log('PASS', 'Loan history table present (has loans)');
    } else {
      log('FAIL', 'Loan history section content');
    }

    // Sign Out button — look in the page layout / navbar
    const signOutFound = await textExists(page, 'Sign Out') || await textExists(page, 'Cerrar sesión') || await textExists(page, 'sign out');
    if (signOutFound) {
      log('PASS', 'Sign Out button');
    } else {
      // Check for a sign-out icon/button
      const logoutBtn = await page.$('[data-testid="sign-out"], [aria-label="Sign Out"], button.logout, .sign-out');
      if (logoutBtn) {
        log('PASS', 'Sign Out button (icon/element)');
      } else {
        log('FAIL', 'Sign Out button', 'not found in page text or selectors');
      }
    }

    // Language toggle
    const langToggle = await page.$('.lang-toggle, [data-testid="lang-toggle"], button.language, .language-switch');
    const langTextFound = await textExists(page, 'EN') || await textExists(page, 'ES') || await textExists(page, 'English') || await textExists(page, 'Español');
    if (langToggle || langTextFound) {
      log('PASS', 'Language toggle');
    } else {
      log('FAIL', 'Language toggle', 'not found');
    }

    // ─── 3. REQUEST FUNDS MODAL ────────────────────────────────────────────────
    console.log('\n═══ STEP 3: REQUEST FUNDS MODAL ═══');

    // Click Request Funds
    const requestFundsBtn = await page.$('.btn-primary');
    if (!requestFundsBtn) {
      log('FAIL', 'Request Funds button click', 'button not found');
      return;
    }
    await requestFundsBtn.click();
    await sleep(500);

    const modalOpen = await selectorExists(page, '.modal-overlay.show');
    if (modalOpen) {
      log('PASS', 'Modal opens on click');
    } else {
      log('FAIL', 'Modal opens on click');
      return;
    }
    await screenshot(page, '03-request-funds-modal');

    // 3a. Check Amount input
    const amountInput = await page.$('.modal input[type="number"]');
    if (amountInput) {
      const amountVal = await page.evaluate((el) => el.value, amountInput);
      log('PASS', 'Amount input exists', `default value = ${amountVal}`);
      if (amountVal === '1000') {
        log('PASS', 'Amount default = $1,000');
      } else {
        log('FAIL', 'Amount default = $1,000', `got ${amountVal}`);
      }
    } else {
      log('FAIL', 'Amount input');
    }

    // 3b. Check CLABE field
    const clabeInput = await page.$('.modal input[type="text"][maxlength="18"], .modal input[inputmode="numeric"]');
    const clabeDisplay = await page.$('.modal span[style*="monospace"]');
    if (clabeInput) {
      log('PASS', 'CLABE field (editable input)');
    } else if (clabeDisplay) {
      log('PASS', 'CLABE field (pre-filled, masked display)');
      const maskedText = await page.evaluate((el) => el.textContent, clabeDisplay);
      console.log(`   CLABE display: ${maskedText}`);
      // Check if edit button exists
      const editBtn = await page.$('.modal button[type="button"]');
      if (editBtn) {
        const editText = await page.evaluate((el) => el.textContent, editBtn);
        log('PASS', 'CLABE edit button', editText.trim());
      }
    } else {
      log('FAIL', 'CLABE field');
    }

    // 3c. Loan purpose dropdown
    const purposeSelect = await page.$('.modal select');
    if (purposeSelect) {
      const options = await page.evaluate((sel) => {
        return Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent }));
      }, purposeSelect);
      log('PASS', `Loan purpose dropdown — ${options.length} options`);
      options.forEach((o) => console.log(`   • ${o.value || '(none)'}: ${o.text}`));
    } else {
      log('FAIL', 'Loan purpose dropdown');
    }

    // 3d. Terms checkbox
    const termsCheckbox = await page.$('.modal input[type="checkbox"]');
    if (termsCheckbox) {
      log('PASS', 'Terms checkbox exists');
    } else {
      log('FAIL', 'Terms checkbox');
    }

    // 3e. Change amount to $2,000 and verify fee
    console.log('\n═══ STEP 4: FEE CALCULATION — $2,000 ═══');
    if (amountInput) {
      await amountInput.click({ clickCount: 3 });
      await amountInput.type('2000');
      await sleep(300);

      const modalText = await page.evaluate(() => {
        const modal = document.querySelector('.modal');
        return modal ? modal.innerText : '';
      });

      // Fee = 30% of 2000 = 600
      if (modalText.includes('600')) {
        log('PASS', 'Fee for $2,000 = $600');
      } else {
        log('FAIL', 'Fee for $2,000 = $600', 'not found in modal text');
      }

      // Total = 2000 + 600 = 2600
      if (modalText.includes('2,600') || modalText.includes('2600')) {
        log('PASS', 'Total repayment for $2,000 = $2,600');
      } else {
        log('FAIL', 'Total repayment for $2,000 = $2,600', 'not found in modal text');
      }

      await screenshot(page, '04-modal-2000-fee');
    }

    // 3f. CAT percentage
    const catHighlight = await page.$('.cat-highlight');
    if (catHighlight) {
      const catText = await page.evaluate((el) => el.textContent, catHighlight);
      log('PASS', 'CAT percentage displayed', catText.trim());
      if (catText.includes('2334') || catText.includes('2,334')) {
        log('PASS', 'CAT ≈ 2334% annual');
      } else {
        log('FAIL', 'CAT ≈ 2334% annual', `got ${catText.trim()}`);
      }
    } else {
      log('FAIL', 'CAT percentage');
    }

    // 3g. CONDUSEF reference
    const condusefLink = await page.$('.modal a[href*="condusef"]');
    const catNote = await page.$('.cat-note');
    if (condusefLink) {
      const condusefText = await page.evaluate((el) => el.textContent, condusefLink);
      log('PASS', 'CONDUSEF reference link', condusefText.trim());
    } else {
      log('FAIL', 'CONDUSEF reference link');
    }
    if (catNote) {
      const noteText = await page.evaluate((el) => el.textContent, catNote);
      log('PASS', 'CAT/CONDUSEF legend/note', noteText.trim().slice(0, 80) + '…');
    } else {
      log('FAIL', 'CAT/CONDUSEF legend/note');
    }

    // 3h. Close modal via X button
    console.log('\n═══ STEP 5: CLOSE & REOPEN MODAL ═══');
    const closeBtn = await page.$('.modal-close');
    if (closeBtn) {
      await closeBtn.click();
      await sleep(300);
      const modalGone = !(await selectorExists(page, '.modal-overlay.show'));
      if (modalGone) {
        log('PASS', 'Modal closes cleanly via X button');
      } else {
        log('FAIL', 'Modal closes via X button');
      }
    } else {
      log('FAIL', 'Close button (X)');
    }

    // 3i. Reopen and check fields reset
    const reopenBtn = await page.$('.btn-primary');
    if (reopenBtn) {
      await reopenBtn.click();
      await sleep(500);
      const amountInputAfter = await page.$('.modal input[type="number"]');
      if (amountInputAfter) {
        const resetVal = await page.evaluate((el) => el.value, amountInputAfter);
        if (resetVal === '1000') {
          log('PASS', 'Fields reset on reopen', `amount = ${resetVal}`);
        } else {
          log('FAIL', 'Fields reset on reopen', `amount = ${resetVal}, expected 1000`);
        }
      }
      // Check purpose reset
      const purposeAfter = await page.$('.modal select');
      if (purposeAfter) {
        const purposeVal = await page.evaluate((el) => el.value, purposeAfter);
        if (purposeVal === '') {
          log('PASS', 'Loan purpose reset on reopen');
        } else {
          log('FAIL', 'Loan purpose reset on reopen', `value = ${purposeVal}`);
        }
      }
      // Check terms reset
      const termsAfter = await page.$('.modal input[type="checkbox"]');
      if (termsAfter) {
        const termsChecked = await page.evaluate((el) => el.checked, termsAfter);
        if (!termsChecked) {
          log('PASS', 'Terms checkbox reset on reopen');
        } else {
          log('FAIL', 'Terms checkbox reset on reopen', 'still checked');
        }
      }
    }

    // Close modal for fee calc tests (via backdrop)
    const overlay = await page.$('.modal-overlay.show');
    if (overlay) {
      // Click at top-left corner of overlay (outside the modal)
      const box = await overlay.boundingBox();
      if (box) {
        await page.mouse.click(box.x + 5, box.y + 5);
        await sleep(300);
        const closedByBackdrop = !(await selectorExists(page, '.modal-overlay.show'));
        if (closedByBackdrop) {
          log('PASS', 'Modal closes via backdrop click');
        } else {
          // Try closing via X instead
          const xBtn = await page.$('.modal-close');
          if (xBtn) await xBtn.click();
          await sleep(300);
          log('FAIL', 'Modal closes via backdrop click', 'used X fallback');
        }
      }
    }

    // ─── 4. FEE CALCULATION VERIFICATION ───────────────────────────────────────
    console.log('\n═══ STEP 6: FEE CALCULATION VERIFICATION ═══');
    const testAmounts = [500, 1000, 2000, 3000, 4500];

    for (const testAmount of testAmounts) {
      // Open modal
      const openBtn = await page.$('.btn-primary');
      if (!openBtn) {
        log('FAIL', `Fee calc for $${testAmount}`, 'could not open modal');
        continue;
      }
      await openBtn.click();
      await sleep(500);

      const modalVisible = await selectorExists(page, '.modal-overlay.show');
      if (!modalVisible) {
        log('FAIL', `Fee calc for $${testAmount}`, 'modal did not open');
        continue;
      }

      const amtInput = await page.$('.modal input[type="number"]');
      if (!amtInput) {
        log('FAIL', `Fee calc for $${testAmount}`, 'amount input not found');
        continue;
      }

      // Clear and set amount
      await amtInput.click({ clickCount: 3 });
      await amtInput.type(String(testAmount));
      await sleep(300);

      // Read modal text
      const mText = await page.evaluate(() => {
        const m = document.querySelector('.modal');
        return m ? m.innerText : '';
      });

      const expectedFee = Math.round(testAmount * 0.30);
      const expectedTotal = testAmount + expectedFee;

      // Check fee
      const feeStr = expectedFee.toLocaleString('en-US');
      const feeFound = mText.includes(feeStr) || mText.includes(String(expectedFee));
      if (feeFound) {
        log('PASS', `Fee for $${testAmount.toLocaleString()} = $${feeStr}`);
      } else {
        log('FAIL', `Fee for $${testAmount.toLocaleString()} = $${feeStr}`, `not found in modal`);
      }

      // Check total
      const totalStr = expectedTotal.toLocaleString('en-US');
      const totalFound = mText.includes(totalStr) || mText.includes(String(expectedTotal));
      if (totalFound) {
        log('PASS', `Total for $${testAmount.toLocaleString()} = $${totalStr}`);
      } else {
        log('FAIL', `Total for $${testAmount.toLocaleString()} = $${totalStr}`, `not found in modal`);
      }

      console.log(`   Amount: $${testAmount.toLocaleString()} | Fee: $${feeStr} | Total: $${totalStr}`);

      // Close modal
      const xClose = await page.$('.modal-close');
      if (xClose) {
        await xClose.click();
        await sleep(300);
      }
    }

    // ─── SUMMARY ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`AUDIT-3b RESULTS: ${passCount} PASS / ${failCount} FAIL / ${passCount + failCount} TOTAL`);
    console.log('═'.repeat(60));

  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err.message);
    await screenshot(page, 'error-fatal').catch(() => {});
  } finally {
    await browser.close();
  }
})();
