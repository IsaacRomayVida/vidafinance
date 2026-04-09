const puppeteer = require('puppeteer');
const wait = ms => new Promise(r => setTimeout(r, ms));
const fs = require('fs');
fs.mkdirSync('/tmp/vida-audit', { recursive: true });
const ss = async (p,n) => { await p.screenshot({path:`/tmp/vida-audit/mm-${n}.png`}); console.log('SS '+n); };

async function dragAndDrop(page, sourceSelector, targetSelector) {
  const source = await page.$(sourceSelector);
  const target = await page.$(targetSelector);
  if (!source || !target) return false;

  const sb = await source.boundingBox();
  const tb = await target.boundingBox();
  if (!sb || !tb) return false;

  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await wait(200);
  // Move in steps
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      sx + (tx - sx) * i / steps,
      sy + (ty - sy) * i / steps
    );
    await wait(50);
  }
  await wait(200);
  await page.mouse.up();
  return true;
}

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: 'ws://127.0.0.1:50357/devtools/browser/1fb4a7c0-c68b-45a9-a08c-2c993505cb84'
  });
  
  const pages = await browser.pages();
  const page = pages[pages.length - 1];

  if (!page.url().includes('69d63c07940df362adbef105')) {
    await page.goto('https://dashboard.metamap.com/flow/69d63c07940df362adbef105', {waitUntil:'networkidle2',timeout:30000});
    await wait(3000);
  }

  // === 1. Add Credit Check ===
  console.log('=== Adding Credit Check ===');
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Credit Decisioning'))?.click();
  });
  await wait(1500);

  // Find the Credit Check element and the drop zone
  const creditResult = await page.evaluate(() => {
    const tools = [...document.querySelectorAll('[class*="tool"], [class*="draggable"], [draggable]')];
    const dropZones = [...document.querySelectorAll('[class*="drop"], [class*="placeholder"]')];
    return {
      toolCount: tools.length,
      dropCount: dropZones.length,
      toolClasses: tools.slice(0, 5).map(t => t.className.substring(0, 80)),
      dropClasses: dropZones.slice(0, 5).map(d => d.className.substring(0, 80)),
    };
  });
  console.log('Draggable elements:', JSON.stringify(creditResult));

  // Try to find elements by their text and drag
  const positions = await page.evaluate(() => {
    const allDivs = [...document.querySelectorAll('div')];
    
    // Find "Credit Check" tool
    const creditDiv = allDivs.find(d => {
      const t = d.textContent.trim();
      return (t === 'Credit Check' || t === 'Credit CheckNever used') && d.offsetHeight > 10 && d.offsetHeight < 80;
    });
    
    // Find the drop zone text "Drag one of the tools here"
    const dropDiv = allDivs.find(d => d.textContent.includes('Drag one of the tools here') && d.offsetHeight > 10);
    
    let creditPos = null, dropPos = null;
    if (creditDiv) {
      const r = creditDiv.getBoundingClientRect();
      creditPos = { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
    }
    if (dropDiv) {
      const r = dropDiv.getBoundingClientRect();
      dropPos = { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
    }
    
    return { creditPos, dropPos };
  });
  console.log('Positions:', JSON.stringify(positions));

  if (positions.creditPos && positions.dropPos) {
    const s = positions.creditPos;
    const t = positions.dropPos;
    
    console.log(`Dragging from (${s.x},${s.y}) to (${t.x},${t.y})`);
    
    await page.mouse.move(s.x, s.y);
    await wait(300);
    await page.mouse.down();
    await wait(300);
    
    // Slow drag
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        s.x + (t.x - s.x) * i / steps,
        s.y + (t.y - s.y) * i / steps
      );
      await wait(30);
    }
    await wait(300);
    await page.mouse.up();
    await wait(1000);
    
    await ss(page, '50-after-drag-credit');
    
    // Check if added
    const ceNow = await page.evaluate(() => {
      const text = document.body.innerText;
      const ceIdx = text.indexOf('Customer Experience');
      return ceIdx > 0 ? text.substring(ceIdx, ceIdx + 300) : 'NOT FOUND';
    });
    console.log('After drag: ' + ceNow);
  }

  console.log('\nDONE');
})();
