const puppeteer = require('puppeteer');
const HS = process.env.HOME + '/.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.153/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const wait = ms => new Promise(r => setTimeout(r, ms));

(async()=>{
  const browser = await puppeteer.launch({executablePath:HS,headless:true,protocolTimeout:120000,args:['--no-sandbox']});
  const page = await browser.newPage();
  
  // Login as admin
  await page.goto('https://vida-finance.web.app/login',{waitUntil:'networkidle2',timeout:15000});
  await wait(1000);
  await(await page.$('input[type="email"]')).click({clickCount:3});
  await(await page.$('input[type="email"]')).type('test-admin@vida-test.com',{delay:5});
  await(await page.$('input[type="password"]')).click({clickCount:3});
  await(await page.$('input[type="password"]')).type('TestPass123!',{delay:5});
  await page.evaluate(()=>document.querySelector('button[type="submit"]')?.click());
  for(let j=0;j<15;j++){await wait(1000);if(!page.url().includes('/login'))break;}
  await wait(2000);
  console.log('Logged in as admin');

  // Call cleanup function from browser context
  const result = await page.evaluate(async () => {
    const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js');
    // Use the already-initialized Firebase app
    const functions = getFunctions(undefined);
    const cleanup = httpsCallable(functions, 'cleanupJunkEmployers');
    const r = await cleanup({});
    return r.data;
  });

  console.log('Cleanup result:', JSON.stringify(result, null, 2));
  await browser.close();
})();
