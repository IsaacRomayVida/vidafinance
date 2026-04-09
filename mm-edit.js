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

  // Click on VIDA Employee KYC flow
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('tr, [class*="row"], a, div')];
    const kyc = rows.find(r => r.textContent.includes('VIDA Employee KYC'));
    if (kyc) { kyc.click(); return true; }
    return false;
  });
  await wait(3000);
  console.log('URL after click: ' + page.url());
  await ss(page, '20-kyc-flow');

  // Get the flow editor content
  const editorText = await page.evaluate(() => document.body.innerText);
  console.log('Flow editor:\n' + editorText.substring(0, 3000));

  console.log('\nDONE');
})();
