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

  // Try direct URL to the flow editor
  await page.goto('https://dashboard.metamap.com/flow/69d63c07940df362adbef105', {waitUntil:'networkidle2',timeout:30000});
  await wait(3000);
  console.log('URL: ' + page.url());
  await ss(page, '21-flow-editor');

  const text = await page.evaluate(() => document.body.innerText);
  console.log('Content:\n' + text.substring(0, 3000));

  // Get all clickable elements
  const clickables = await page.evaluate(() => {
    return [...document.querySelectorAll('button, a, [role="button"]')].map(el => ({
      tag: el.tagName, text: el.textContent.trim().substring(0,50), href: el.href || ''
    })).filter(e => e.text.length > 0);
  });
  console.log('\nClickable elements:');
  clickables.forEach(c => console.log('  ' + c.tag + ': ' + c.text + (c.href ? ' → ' + c.href : '')));

  console.log('\nDONE');
})();
