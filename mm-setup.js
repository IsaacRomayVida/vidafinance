const puppeteer = require('puppeteer');
const HS = process.env.HOME + '/.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.153/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const wait = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
fs.mkdirSync('/tmp/vida-audit', { recursive: true });
const ss = async (p,n) => { await p.screenshot({path:`/tmp/vida-audit/mm-${n}.png`}); console.log('SS '+n); };

(async () => {
  const browser = await puppeteer.launch({executablePath:HS,headless:true,protocolTimeout:120000,args:['--no-sandbox']});
  const page = await browser.newPage();
  await page.setViewport({width:1400,height:900});

  // Login
  await page.goto('https://dashboard.metamap.com/', {waitUntil:'networkidle2',timeout:30000});
  await wait(3000);
  
  const inputs = await page.$$('input');
  if (inputs.length >= 2) {
    await inputs[0].click();
    await inputs[0].type('isaac@vidateam.mx', {delay:10});
    await inputs[1].click();
    await inputs[1].type('Daniel?112012', {delay:10});
    await wait(500);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const login = btns.find(b => b.textContent.includes('Log') || b.textContent.includes('Sign'));
      if (login) login.click();
    });
    await wait(8000);
    console.log('URL: ' + page.url());
    await ss(page, '01-dashboard');
  }

  // Get sidebar/navigation
  const navText = await page.evaluate(() => {
    const nav = document.querySelector('nav') || document.querySelector('[class*="sidebar"]') || document.querySelector('[class*="menu"]');
    return nav ? nav.innerText : 'NO NAV';
  });
  console.log('Nav: ' + navText.substring(0, 500));

  // Find and click on flows/workflows
  await page.evaluate(() => {
    const links = [...document.querySelectorAll('a, button, [role="button"]')];
    const flow = links.find(l => l.textContent.match(/flow|workflow|metamap/i) && !l.textContent.match(/document|log|sign/i));
    if (flow) { flow.click(); return true; }
    return false;
  });
  await wait(3000);
  console.log('URL after nav: ' + page.url());
  await ss(page, '02-flows');

  // Get full page text to understand layout
  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('Page content: ' + pageText.substring(0, 1500));

  await browser.close();
})();
