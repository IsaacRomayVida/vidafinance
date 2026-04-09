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
  console.log('Pages: ' + pages.length);
  const page = pages[pages.length - 1];
  console.log('Current URL: ' + page.url());
  await ss(page, '10-current');

  // Navigate to flows
  await page.goto('https://dashboard.metamap.com/flow', {waitUntil:'networkidle2',timeout:30000});
  await wait(3000);
  console.log('Flows URL: ' + page.url());
  await ss(page, '11-flows');

  const flowsText = await page.evaluate(() => document.body.innerText);
  console.log('Flows:\n' + flowsText.substring(0, 2000));

  // Don't close browser - keep it alive
  console.log('\nDONE - browser still open');
})();
