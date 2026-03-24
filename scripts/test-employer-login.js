/**
 * E2E Test: Employer Login Flow
 *
 * Verifies that an employer user can log in and is redirected
 * to the /employer dashboard. Uses Puppeteer headless Chrome.
 *
 * Usage:
 *   node scripts/test-employer-login.js
 *
 * Prerequisites:
 *   - Custom claims must be set for the test employer account
 *   - The test account must exist in Firebase Auth
 */

const puppeteer = require("puppeteer");

const TEST_EMAIL = "test-employer-1774134933675@vida-test.com";
const TEST_PASSWORD = "TestPass123!";
const LOGIN_URL = "https://vida-finance.web.app/login";
const POST_LOGIN_WAIT_MS = 10_000;

async function run() {
  console.log("\nVIDA Finance — Employer Login E2E Test\n" + "=".repeat(50));

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        console.log("[NAV]", frame.url());
      }
    });

    console.log("[INFO] Navigating to login page...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

    console.log("[INFO] Entering credentials...");
    await page.type("input[type=email]", TEST_EMAIL);
    await page.type("input[type=password]", TEST_PASSWORD);

    console.log("[INFO] Submitting login form...");
    await page.click("button[type=submit]");

    // Wait for post-login redirect
    await new Promise((r) => setTimeout(r, POST_LOGIN_WAIT_MS));

    const url = page.url();
    const pageText = await page.evaluate(() =>
      document.body.innerText.substring(0, 600)
    );

    console.log("[URL]", url);
    console.log("[PAGE]", pageText);

    console.log("\n" + "=".repeat(50));
    if (url.includes("/employer")) {
      console.log("PASS — Employer redirected to employer dashboard");
      return 0;
    } else {
      console.log("FAIL — Expected /employer in URL, got:", url);
      return 1;
    }
  } finally {
    await browser.close();
  }
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("[ERROR]", e.message);
    process.exit(1);
  });
