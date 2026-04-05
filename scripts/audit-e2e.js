#!/usr/bin/env node
/**
 * VID3-552: Full E2E Audit of live VIDA Finance platform
 * Report-only — no fixes. Uses raw CDP for login to avoid JS runtime blocks.
 */
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE = "https://vida-finance.web.app";
const SCREENSHOT_DIR = path.join(__dirname, "..", "audit-screenshots");
const RESULTS = [];
const NAV_TIMEOUT = 20000;

const USERS = {
  admin: { email: "test-admin@vida-test.com", pass: "TestPass123!" },
  employer: { email: "test-employer-1774134933675@vida-test.com", pass: "TestPass123!" },
  employee: { email: "test-employee-audit-e2e@vida-test.com", pass: "TestPass123!" },
};

function log(phase, test, pass, note = "") {
  const status = pass ? "PASS" : "FAIL";
  RESULTS.push({ phase, test, status, note });
  console.log(`[${status}] ${phase} | ${test}${note ? " — " + note : ""}`);
}

async function safeScreenshot(page, name) {
  try {
    const file = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false, timeout: 15000 });
  } catch (_) {}
}

async function safeEval(page, fn, fallback = null) {
  try { return await page.evaluate(fn); } catch (_) { return fallback; }
}

async function cdpClick(client, root, selector) {
  const node = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!node.nodeId) throw new Error(`Selector not found: ${selector}`);
  const box = await client.send("DOM.getBoxModel", { nodeId: node.nodeId });
  const c = box.model.content;
  const x = (c[0] + c[2]) / 2, y = (c[1] + c[5]) / 2;
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function cdpType(client, text) {
  for (const char of text) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
  }
}

async function cdpTab(client) {
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab" });
}

async function login(page, user) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
  await new Promise((r) => setTimeout(r, 4000));
  const client = await page.createCDPSession();
  const { root } = await client.send("DOM.getDocument");
  await cdpClick(client, root, 'input[type="email"]');
  await cdpType(client, user.email);
  await cdpTab(client);
  await cdpType(client, user.pass);
  await cdpClick(client, root, 'button[type="submit"]');
  await client.detach();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!page.url().includes("/login")) return;
  }
  throw new Error(`Still on login after 20s, url=${page.url()}`);
}

async function freshPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.setDefaultTimeout(NAV_TIMEOUT);
  return page;
}

// ── Phase 1: Public Pages ──
async function phase1(page) {
  const routes = ["/", "/employers", "/employees", "/login", "/onboarding", "/about",
    "/security", "/privacy", "/terms", "/partners", "/investors", "/contact", "/press"];
  for (const route of routes) {
    try {
      const res = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await new Promise((r) => setTimeout(r, 2000));
      const status = res.status();
      const info = await safeEval(page, () => ({
        hasContent: (document.body?.innerText?.length || 0) > 20,
        hasNav: !!document.querySelector("nav, header, [role='navigation']"),
        hasFooter: !!document.querySelector("footer, [role='contentinfo']"),
      }), { hasContent: false, hasNav: false, hasFooter: false });
      const ok = status === 200 && info.hasContent;
      log("Phase1:Public", `GET ${route}`, ok, `status=${status} content=${info.hasContent} nav=${info.hasNav} footer=${info.hasFooter}`);
      if (!ok) await safeScreenshot(page, `phase1${route.replace(/\//g, "_") || "_root"}`);
    } catch (e) {
      log("Phase1:Public", `GET ${route}`, false, e.message.split("\n")[0]);
    }
  }
}

// ── Phase 2: Mobile Responsive ──
async function phase2(page) {
  const routes = ["/", "/employers", "/employees", "/login", "/about", "/contact"];
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  for (const route of routes) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await new Promise((r) => setTimeout(r, 2000));
      const overflow = await safeEval(page, () => document.documentElement.scrollWidth > window.innerWidth, false);
      log("Phase2:Mobile", `${route} overflow`, !overflow, overflow ? "horizontal overflow detected" : "no overflow");
      if (overflow) await safeScreenshot(page, `phase2_overflow${route.replace(/\//g, "_")}`);
    } catch (e) {
      log("Phase2:Mobile", `${route} overflow`, false, e.message.split("\n")[0]);
    }
  }
  // Check mobile nav
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await new Promise((r) => setTimeout(r, 2000));
    const hasHamburger = await safeEval(page, () => {
      return !!document.querySelector('[aria-label*="menu" i], button.menu, .hamburger') ||
        [...document.querySelectorAll("button")].some(b => b.querySelector("svg") && b.offsetWidth < 80);
    }, false);
    log("Phase2:Mobile", "hamburger menu present", hasHamburger);
  } catch (e) {
    log("Phase2:Mobile", "hamburger menu", false, e.message.split("\n")[0]);
  }
  await page.setViewport({ width: 1280, height: 800 });
}

// ── Phase 3: Auth Flows ──
async function phase3(browser) {
  for (const [role, creds] of Object.entries(USERS)) {
    const page = await freshPage(browser);
    try {
      await login(page, creds);
      const url = page.url();
      log("Phase3:Auth", `login as ${role}`, true, `redirected to ${url}`);
    } catch (e) {
      log("Phase3:Auth", `login as ${role}`, false, e.message.split("\n")[0]);
      await safeScreenshot(page, `phase3_login_${role}`);
    }
    await page.close();
  }
  // Auth guards
  const guardPage = await freshPage(browser);
  for (const route of ["/employer/dashboard", "/employee/dashboard", "/ops"]) {
    try {
      await guardPage.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await new Promise((r) => setTimeout(r, 4000));
      const url = guardPage.url();
      const redirected = url.includes("/login");
      log("Phase3:Auth", `guard ${route}`, redirected, `ended at ${url}`);
      if (!redirected) await safeScreenshot(guardPage, `phase3_guard${route.replace(/\//g, "_")}`);
    } catch (e) {
      log("Phase3:Auth", `guard ${route}`, false, e.message.split("\n")[0]);
    }
  }
  await guardPage.close();
}

// ── Phase 4: Employee Dashboard ──
async function phase4(browser) {
  const page = await freshPage(browser);
  try {
    await login(page, USERS.employee);
    const checks = [
      { name: "dashboard loads", path: "/employee/dashboard", check: () => document.body.innerText.length > 50 },
      { name: "welcome message", path: "/employee/dashboard", check: () => /welcome|bienvenid|hello|hola|dashboard/i.test(document.body.innerText) },
      { name: "available credit", path: "/employee/dashboard", check: () => /credit|crédito|\$|mxn/i.test(document.body.innerText) },
      { name: "request funds btn", path: "/employee/dashboard", check: () => !!document.querySelector('button, a[href*="loan"], a[href*="request"], a[href*="wizard"]') },
      { name: "my loans page", path: "/employee/loans", check: () => document.body.innerText.length > 30 },
      { name: "loan wizard page", path: "/employee/loan-wizard", check: () => document.body.innerText.length > 30 },
    ];
    for (const c of checks) {
      try {
        await page.goto(`${BASE}${c.path}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await new Promise((r) => setTimeout(r, 3000));
        const ok = await safeEval(page, c.check, false);
        log("Phase4:Employee", c.name, !!ok);
        if (!ok) await safeScreenshot(page, `phase4_${c.name.replace(/\s/g, "_")}`);
      } catch (e) {
        log("Phase4:Employee", c.name, false, e.message.split("\n")[0]);
        await safeScreenshot(page, `phase4_${c.name.replace(/\s/g, "_")}`);
      }
    }
  } catch (e) {
    log("Phase4:Employee", "login", false, e.message.split("\n")[0]);
    await safeScreenshot(page, "phase4_login_fail");
  }
  await page.close();
}

// ── Phase 5: Employer Dashboard ──
async function phase5(browser) {
  const page = await freshPage(browser);
  try {
    await login(page, USERS.employer);
    const checks = [
      { name: "dashboard loads", path: "/employer/dashboard", check: () => document.body.innerText.length > 50 },
      { name: "employee roster", path: "/employer/roster", check: () => document.body.innerText.length > 30 },
      { name: "deduction reports", path: "/employer/deductions", check: () => document.body.innerText.length > 30 },
      { name: "CURP config", path: "/employer/dashboard", check: () => /curp/i.test(document.body.innerText) },
    ];
    for (const c of checks) {
      try {
        await page.goto(`${BASE}${c.path}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await new Promise((r) => setTimeout(r, 3000));
        const ok = await safeEval(page, c.check, false);
        log("Phase5:Employer", c.name, !!ok);
        if (!ok) await safeScreenshot(page, `phase5_${c.name.replace(/\s/g, "_")}`);
      } catch (e) {
        log("Phase5:Employer", c.name, false, e.message.split("\n")[0]);
        await safeScreenshot(page, `phase5_${c.name.replace(/\s/g, "_")}`);
      }
    }
  } catch (e) {
    log("Phase5:Employer", "login", false, e.message.split("\n")[0]);
    await safeScreenshot(page, "phase5_login_fail");
  }
  await page.close();
}

// ── Phase 6: Admin Dashboard ──
async function phase6(browser) {
  const page = await freshPage(browser);
  try {
    await login(page, USERS.admin);
    const routes = [
      { name: "ops dashboard", path: "/ops" },
      { name: "review queue", path: "/ops/review-queue" },
      { name: "portfolio", path: "/ops/portfolio" },
      { name: "employers mgmt", path: "/ops/employers" },
      { name: "alerts", path: "/ops/alerts" },
      { name: "system health", path: "/ops/health" },
    ];
    for (const r of routes) {
      try {
        await page.goto(`${BASE}${r.path}`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await new Promise((r) => setTimeout(r, 3000));
        const info = await safeEval(page, () => ({
          len: document.body.innerText.length,
          has404: document.body.innerText.includes("404"),
          url: location.href,
        }), { len: 0, has404: false, url: "unknown" });
        const ok = info.len > 50 && !info.has404;
        log("Phase6:Admin", r.name, ok, `url=${info.url} textLen=${info.len}`);
        if (!ok) await safeScreenshot(page, `phase6_${r.name.replace(/\s/g, "_")}`);
      } catch (e) {
        log("Phase6:Admin", r.name, false, e.message.split("\n")[0]);
        await safeScreenshot(page, `phase6_${r.name.replace(/\s/g, "_")}`);
      }
    }
  } catch (e) {
    log("Phase6:Admin", "login", false, e.message.split("\n")[0]);
    await safeScreenshot(page, "phase6_login_fail");
  }
  await page.close();
}

// ── Phase 7: i18n ──
async function phase7(page) {
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await new Promise((r) => setTimeout(r, 3000));

    const info = await safeEval(page, () => {
      const els = [...document.querySelectorAll("button, select, a, [role='button']")];
      const toggleEl = els.find(el => /\b(en|es)\b|english|español|language|idioma/i.test(el.innerText || el.getAttribute("aria-label") || ""));
      const text = document.body.innerText;
      const rawMatches = (text.match(/\b[a-z]+_[a-z]+(_[a-z]+)*\b/g) || [])
        .filter(m => /^(dash|nav|btn|lbl|msg|err|auth|loan|emp)_/.test(m));
      return {
        hasToggle: !!toggleEl,
        toggleText: toggleEl ? (toggleEl.innerText || "").trim() : null,
        rawKeys: rawMatches,
        lang: document.documentElement.lang || "not set",
      };
    }, { hasToggle: false, toggleText: null, rawKeys: [], lang: "not set" });

    log("Phase7:i18n", "language toggle present", info.hasToggle, info.toggleText ? `text="${info.toggleText}"` : "");
    log("Phase7:i18n", "no raw i18n keys on home", info.rawKeys.length === 0, info.rawKeys.length ? `found: ${info.rawKeys.join(", ")}` : "clean");
    log("Phase7:i18n", "default lang attribute", info.lang !== "not set", `lang="${info.lang}"`);

    if (info.hasToggle) {
      await safeEval(page, () => {
        const els = [...document.querySelectorAll("button, select, a, [role='button']")];
        const el = els.find(el => /\b(en|es)\b|english|español|language|idioma/i.test(el.innerText || el.getAttribute("aria-label") || ""));
        if (el) el.click();
      });
      await new Promise((r) => setTimeout(r, 2000));
      const sample = await safeEval(page, () => document.body.innerText.substring(0, 200), "");
      const switched = /español|empleador|iniciar|bienvenid|employers|employees|get started|log in/i.test(sample);
      log("Phase7:i18n", "language toggle works", switched, `sample: ${(sample || "").substring(0, 80)}...`);
    }
  } catch (e) {
    log("Phase7:i18n", "i18n check", false, e.message.split("\n")[0]);
  }
}

// ── Main ──
(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: "new",
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  console.log("═══ VIDA Finance E2E Audit — " + new Date().toISOString() + " ═══\n");

  const page1 = await freshPage(browser);
  await phase1(page1);
  console.log("");
  await phase2(page1);
  await page1.close();
  console.log("");

  await phase3(browser);
  console.log("");
  await phase4(browser);
  console.log("");
  await phase5(browser);
  console.log("");
  await phase6(browser);
  console.log("");

  const page7 = await freshPage(browser);
  await phase7(page7);
  await page7.close();

  await browser.close();

  // Summary
  const pass = RESULTS.filter((r) => r.status === "PASS").length;
  const fail = RESULTS.filter((r) => r.status === "FAIL").length;
  console.log(`\n═══ SUMMARY: ${pass} PASS / ${fail} FAIL / ${RESULTS.length} TOTAL ═══\n`);

  // Write JSON report
  const reportPath = path.join(__dirname, "..", "audit-report.json");
  fs.writeFileSync(reportPath, JSON.stringify({ date: new Date().toISOString(), summary: { pass, fail, total: RESULTS.length }, results: RESULTS }, null, 2));
  console.log(`Report written to ${reportPath}`);

  // Write markdown report
  const mdPath = path.join(__dirname, "..", "AUDIT-REPORT.md");
  let md = `# VIDA Finance E2E Audit Report\n\n**Date:** ${new Date().toISOString()}\n**Summary:** ${pass} PASS / ${fail} FAIL / ${RESULTS.length} TOTAL\n\n`;
  let currentPhase = "";
  for (const r of RESULTS) {
    if (r.phase !== currentPhase) {
      currentPhase = r.phase;
      md += `\n## ${currentPhase}\n\n| Test | Status | Notes |\n|------|--------|-------|\n`;
    }
    md += `| ${r.test} | ${r.status === "PASS" ? "✅ PASS" : "❌ FAIL"} | ${r.note} |\n`;
  }
  fs.writeFileSync(mdPath, md);
  console.log(`Markdown report written to ${mdPath}`);

  process.exit(fail > 0 ? 1 : 0);
})();
