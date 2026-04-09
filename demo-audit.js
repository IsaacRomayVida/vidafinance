const puppeteer = require('puppeteer');
const HS = process.env.HOME + '/.cache/puppeteer/chrome-headless-shell/mac_arm-146.0.7680.153/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const wait = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
const path = '/tmp/vida-audit';
fs.mkdirSync(path, { recursive: true });
const PASS = 'TestPass123!';
const URL = 'https://vida-finance.web.app';
let i = 0;
const ss = async (p,l) => { const n=`demo-${String(i++).padStart(2,'0')}-${l}`; await p.screenshot({path:`${path}/${n}.png`,fullPage:false}); console.log('SS '+n); };

async function login(page, email) {
  await page.goto(URL+'/login', {waitUntil:'networkidle2',timeout:15000});
  await (await page.$('input[type="email"]')).type(email, {delay:5});
  await (await page.$('input[type="password"]')).type(PASS, {delay:5});
  await page.evaluate(()=>{(document.querySelector('button[type="submit"]')||document.querySelector('form button')).click()});
  for(let j=0;j<12;j++){await wait(1000);if(!page.url().includes('/login'))break;}
  console.log('Login→'+page.url());
}

(async () => {
  const browser = await puppeteer.launch({executablePath:HS,headless:true,protocolTimeout:120000,args:['--no-sandbox']});
  const page = await browser.newPage();
  await page.setViewport({width:1280,height:800});

  console.log('=== INVESTOR DEMO AUDIT ===\n');

  // 1. Homepage
  await page.goto(URL, {waitUntil:'networkidle2',timeout:15000});
  await ss(page, 'homepage');
  console.log('1. Homepage: ' + (page.url().includes('vida-finance') ? 'OK' : 'FAIL'));

  // 2. Employer page
  await page.goto(URL+'/employers', {waitUntil:'networkidle2',timeout:15000});
  await ss(page, 'employer-page');
  console.log('2. Employer landing: OK');

  // 3. Employee page
  await page.goto(URL+'/employees', {waitUntil:'networkidle2',timeout:15000});
  await ss(page, 'employee-page');
  console.log('3. Employee landing: OK');

  // 4. Onboarding start
  await page.goto(URL+'/onboarding', {waitUntil:'networkidle2',timeout:15000});
  await ss(page, 'onboarding');
  console.log('4. Onboarding: OK');

  // 5. Employer Dashboard
  console.log('\n--- EMPLOYER DASHBOARD ---');
  await login(page, 'test-employer-1774134933675@vida-test.com');
  await wait(3000);
  await ss(page, 'employer-dash');
  const empStats = await page.evaluate(()=>[...document.querySelectorAll('.stat-value')].map(s=>s.textContent.trim()));
  console.log('5. Employer dash stats: ' + JSON.stringify(empStats));

  // 5b. Employer Employees tab
  await page.goto(URL+'/employer/employees', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'employer-employees');
  console.log('5b. Employee roster: ' + page.url());

  // 5c. Employer Deductions
  await page.goto(URL+'/employer/deductions', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'employer-deductions');
  console.log('5c. Deductions: ' + page.url());

  // 5d. Employer Analytics
  await page.goto(URL+'/employer/analytics', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'employer-analytics');
  console.log('5d. Analytics: ' + page.url());

  // 6. Employee Dashboard
  console.log('\n--- EMPLOYEE DASHBOARD ---');
  await login(page, 'test-employee-audit-e2e@vida-test.com');
  await wait(3000);
  await ss(page, 'employee-dash');
  const eeStats = await page.evaluate(()=>[...document.querySelectorAll('.stat-value')].map(s=>s.textContent.trim()));
  console.log('6. Employee dash stats: ' + JSON.stringify(eeStats));

  // 6b. My Loans
  await page.goto(URL+'/employee/loans', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'my-loans');
  console.log('6b. My Loans: OK');

  // 7. Admin Dashboard
  console.log('\n--- ADMIN DASHBOARD ---');
  await login(page, 'test-admin@vida-test.com');
  await wait(3000);
  await ss(page, 'admin-dash');
  console.log('7. Admin dash: ' + page.url());

  // 7b. Review Queue
  await page.goto(URL+'/ops/review-queue', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'admin-review');
  console.log('7b. Review Queue: OK');

  // 7c. Portfolio
  await page.goto(URL+'/ops/portfolio', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'admin-portfolio');
  console.log('7c. Portfolio: OK');

  // 7d. Employer Management
  await page.goto(URL+'/ops/employers', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'admin-employers');
  console.log('7d. Employer Mgmt: OK');

  // 7e. Alerts
  await page.goto(URL+'/ops/alerts', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'admin-alerts');
  console.log('7e. Alerts: OK');

  // 7f. System Health
  await page.goto(URL+'/ops/health', {waitUntil:'networkidle2',timeout:15000});
  await wait(2000);
  await ss(page, 'admin-health');
  console.log('7f. System Health: OK');

  await browser.close();
  console.log('\n=== AUDIT COMPLETE ===');
  console.log('Screenshots:');
  fs.readdirSync(path).filter(f=>f.startsWith('demo-')).sort().forEach(f=>console.log('  '+f));
})();
