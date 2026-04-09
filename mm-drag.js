const puppeteer = require('puppeteer');
const wait = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
fs.mkdirSync('/tmp/vida-audit', { recursive: true });
const ss = async (p,n) => { await p.screenshot({path:`/tmp/vida-audit/mm-${n}.png`}); console.log('SS '+n); };

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: 'ws://127.0.0.1:50357/devtools/browser/1fb4a7c0-c68b-45a9-a08c-2c993505cb84'
  });
  
  const pages = await browser.pages();
  const page = pages[pages.length - 1];

  // Ensure we're on the flow page
  if (!page.url().includes('69d63c07940df362adbef105')) {
    await page.goto('https://dashboard.metamap.com/flow/69d63c07940df362adbef105', {waitUntil:'networkidle2',timeout:30000});
    await wait(3000);
  }

  // === 1. Add Credit Check ===
  console.log('=== Adding Credit Check ===');
  // Click Credit Decisioning category
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Credit Decisioning'))?.click();
  });
  await wait(1500);

  // Find Credit Check div and drag it to the drop zone
  // First try clicking on it
  const creditAdded = await page.evaluate(() => {
    const divs = [...document.querySelectorAll('div')];
    const creditCheck = divs.find(d => {
      const t = d.textContent.trim();
      return t === 'Credit Check' || t === 'Credit CheckNever used';
    });
    if (creditCheck) { creditCheck.click(); return true; }
    return false;
  });
  console.log('Credit Check clicked: ' + creditAdded);
  await wait(2000);
  await ss(page, '40-after-credit-click');

  // Check if it was added to Customer Experience
  const ceText = await page.evaluate(() => {
    const ce = [...document.querySelectorAll('div')].find(d => d.textContent.includes('Customer Experience'));
    return ce ? ce.innerText.substring(0, 500) : 'NOT FOUND';
  });
  console.log('Customer Experience: ' + ceText);

  // === 2. Add Employment History ===
  console.log('\n=== Adding Employment History ===');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Gov Database'))?.click();
  });
  await wait(1500);

  await page.evaluate(() => {
    const divs = [...document.querySelectorAll('div')];
    const emp = divs.find(d => d.textContent.trim().startsWith('Employment History'));
    if (emp) emp.click();
  });
  await wait(2000);
  await ss(page, '41-after-employment-click');

  // === 3. Add Tax Number Verification ===
  console.log('\n=== Adding Tax Number Verification ===');
  await page.evaluate(() => {
    const divs = [...document.querySelectorAll('div')];
    const tax = divs.find(d => d.textContent.trim().startsWith('Tax Number'));
    if (tax) tax.click();
  });
  await wait(2000);
  await ss(page, '42-after-tax-click');

  // Check final state of Customer Experience
  const finalCE = await page.evaluate(() => {
    const text = document.body.innerText;
    const ceIdx = text.indexOf('Customer Experience');
    return ceIdx > 0 ? text.substring(ceIdx, ceIdx + 500) : 'NOT FOUND';
  });
  console.log('\nFinal Customer Experience:\n' + finalCE);

  // Get full page state
  await ss(page, '43-final-state');
  console.log('\nDONE');
})();
