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

  // Make sure we're on the flow editor
  if (!page.url().includes('69d63c07940df362adbef105')) {
    await page.goto('https://dashboard.metamap.com/flow/69d63c07940df362adbef105', {waitUntil:'networkidle2',timeout:30000});
    await wait(3000);
  }

  // Step 1: Click "Credit Decisioning" category to see credit tools
  console.log('=== Exploring Credit Decisioning ===');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Credit Decisioning'));
    if (btn) btn.click();
  });
  await wait(2000);
  await ss(page, '30-credit-category');
  
  const creditTools = await page.evaluate(() => {
    const divs = [...document.querySelectorAll('div')].filter(d => {
      const t = d.textContent.trim();
      return t.length > 5 && t.length < 80 && (t.includes('Credit') || t.includes('credit') || t.includes('Check') || t.includes('Score'));
    });
    return divs.map(d => d.textContent.trim()).slice(0, 20);
  });
  console.log('Credit tools:', creditTools);

  // Get full sidebar content
  const sidebarText = await page.evaluate(() => {
    // Look for the tools panel
    const text = document.body.innerText;
    const toolsIdx = text.indexOf('Tools');
    if (toolsIdx > 0) return text.substring(toolsIdx, toolsIdx + 1500);
    return text.substring(0, 1500);
  });
  console.log('Sidebar:\n' + sidebarText);

  // Step 2: Click "Gov Database" category
  console.log('\n=== Exploring Gov Database ===');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Gov Database'));
    if (btn) btn.click();
  });
  await wait(2000);
  await ss(page, '31-gov-category');

  const govText = await page.evaluate(() => document.body.innerText);
  const govIdx = govText.indexOf('Tools');
  console.log('Gov tools:\n' + (govIdx > 0 ? govText.substring(govIdx, govIdx + 1500) : govText.substring(0, 1500)));

  // Step 3: Click "Custom" category
  console.log('\n=== Exploring Custom ===');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Custom');
    if (btn) btn.click();
  });
  await wait(2000);
  await ss(page, '32-custom-category');

  const customText = await page.evaluate(() => document.body.innerText);
  const customIdx = customText.indexOf('Tools');
  console.log('Custom tools:\n' + (customIdx > 0 ? customText.substring(customIdx, customIdx + 1500) : customText.substring(0, 1500)));

  // Step 4: Click "Compliance" category
  console.log('\n=== Exploring Compliance ===');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Compliance'));
    if (btn) btn.click();
  });
  await wait(2000);
  await ss(page, '33-compliance-category');

  const compText = await page.evaluate(() => document.body.innerText);
  const compIdx = compText.indexOf('Tools');
  console.log('Compliance tools:\n' + (compIdx > 0 ? compText.substring(compIdx, compIdx + 1500) : compText.substring(0, 1500)));

  console.log('\nDONE');
})();
