#!/usr/bin/env node
/**
 * VIDA Design Consistency Audit (VID3-413)
 * Puppeteer-based audit of brand colors, fonts, button styles, CSS variables.
 */
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:3000';
const PAGES = ['/', '/login', '/onboarding', '/employers'];

// Brand palette
const BRAND_PALETTE = {
  teal:       '#194445',
  brandMid:   '#1d5253',
  brandLight: '#247a6e',
  aqua:       '#a8d5d0',
  aquaSoft:   '#dceeed',
  gold:       '#a28657',
  bg:         '#ffffff',
  bg2:        '#f5f8f7',
  t1:         '#0c1e1f',
  t2:         '#4a6364',
  t3:         '#93aaa9',
  canvas:     '#f5f1eb',
  danger:     '#dc503c',
  success:    '#247a6e',
};

// Normalize color to hex for comparison
function rgbToHex(rgb) {
  if (!rgb) return null;
  const m = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return rgb.toLowerCase().trim();
  return '#' + [m[1], m[2], m[3]].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
}

const PALETTE_HEX = new Set(Object.values(BRAND_PALETTE).map(c => c.toLowerCase()));
// Also allow common neutrals
const ALLOWED_EXTRAS = new Set([
  '#000000', '#ffffff', '#fff', '#000',
  '#f5f5f5', '#e0e0e0', '#cccccc', '#333333', '#666666', '#999999',
  '#f0f0f0', '#fafafa', '#eeeeee', '#dddddd', '#aaaaaa', '#888888',
]);

const WRONG_GOLD = '#c9a84c';
const CORRECT_GOLD = '#a28657';

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results = {};

  for (const path of PAGES) {
    const url = BASE + path;
    console.log(`\n========== Auditing ${url} ==========`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch (e) {
      console.log(`  ⚠ Page load issue: ${e.message}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (e2) {
        console.log(`  ✗ Could not load page: ${e2.message}`);
        results[path] = { error: e2.message };
        await page.close();
        continue;
      }
    }

    // Wait a bit for React to render
    await new Promise(r => setTimeout(r, 2000));

    // 1. Extract all computed colors
    const colors = await page.evaluate(() => {
      const els = document.querySelectorAll('*');
      const found = new Set();
      els.forEach(el => {
        const s = getComputedStyle(el);
        ['color', 'backgroundColor', 'borderColor'].forEach(p => {
          const v = s[p];
          if (v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent') found.add(v);
        });
      });
      return [...found];
    });

    // 2. Check CSS custom properties
    const cssVars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        teal: s.getPropertyValue('--teal').trim(),
        gold: s.getPropertyValue('--gold').trim(),
        canvas: s.getPropertyValue('--canvas').trim(),
        brand: s.getPropertyValue('--brand').trim(),
        brandMid: s.getPropertyValue('--brand-mid').trim(),
        brandLight: s.getPropertyValue('--brand-light').trim(),
        aqua: s.getPropertyValue('--aqua').trim(),
        aquaSoft: s.getPropertyValue('--aqua-soft').trim(),
        bg: s.getPropertyValue('--bg').trim(),
        bg2: s.getPropertyValue('--bg2').trim(),
        t1: s.getPropertyValue('--t1').trim(),
        t2: s.getPropertyValue('--t2').trim(),
        t3: s.getPropertyValue('--t3').trim(),
        df: s.getPropertyValue('--df').trim(),
        db: s.getPropertyValue('--db').trim(),
        danger: s.getPropertyValue('--danger').trim(),
        success: s.getPropertyValue('--success').trim(),
      };
    });

    // 3. Check fonts loaded
    const fonts = await page.evaluate(() => {
      const els = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,a,button,label,input');
      const found = {};
      els.forEach(el => {
        const tag = el.tagName;
        const ff = getComputedStyle(el).fontFamily;
        if (!found[tag]) found[tag] = new Set();
        found[tag].add(ff);
      });
      // Convert sets to arrays
      const result = {};
      for (const [k, v] of Object.entries(found)) {
        result[k] = [...v];
      }
      return result;
    });

    // 4. Check for wrong gold color in source
    const goldMismatch = await page.evaluate((wrongGold) => {
      const all = document.querySelectorAll('*');
      const hits = [];
      all.forEach(el => {
        const s = getComputedStyle(el);
        ['color', 'backgroundColor', 'borderColor'].forEach(p => {
          const v = s[p];
          if (v) {
            // Convert to hex for comparison
            const m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (m) {
              const hex = '#' + [m[1], m[2], m[3]].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
              if (hex.toLowerCase() === wrongGold) {
                hits.push({
                  tag: el.tagName,
                  class: el.className?.toString().substring(0, 80) || '',
                  property: p,
                  value: hex,
                });
              }
            }
          }
        });
      });
      return hits;
    }, WRONG_GOLD);

    // 5. Check button consistency
    const buttons = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a[class*="btn"], a[class*="cta"], [role="button"]');
      const data = [];
      btns.forEach(btn => {
        const s = getComputedStyle(btn);
        data.push({
          tag: btn.tagName,
          text: btn.textContent?.trim().substring(0, 50) || '',
          class: btn.className?.toString().substring(0, 80) || '',
          backgroundColor: s.backgroundColor,
          color: s.color,
          borderRadius: s.borderRadius,
          padding: s.padding,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          fontFamily: s.fontFamily,
          border: s.border,
        });
      });
      return data;
    });

    // Analyze colors
    const colorsHex = colors.map(c => rgbToHex(c)).filter(Boolean);
    const offPalette = colorsHex.filter(c => {
      const norm = c.toLowerCase();
      if (PALETTE_HEX.has(norm)) return false;
      if (ALLOWED_EXTRAS.has(norm)) return false;
      // Allow very light/dark grays
      if (/^#([0-9a-f])\1\1\1\1\1$/.test(norm)) return false;
      return true;
    });

    results[path] = {
      colors: { total: colors.length, raw: colors, hex: colorsHex, offPalette },
      cssVars,
      fonts,
      goldMismatch,
      buttons,
    };

    // Print summary for this page
    console.log(`\n  --- CSS Custom Properties ---`);
    console.log(`  --teal:   ${cssVars.teal} ${cssVars.teal === '#194445' ? '✓' : '✗ expected #194445'}`);
    console.log(`  --gold:   ${cssVars.gold} ${cssVars.gold === '#a28657' ? '✓' : '✗ expected #a28657'}`);
    console.log(`  --canvas: ${cssVars.canvas} ${cssVars.canvas === '#f5f1eb' ? '✓' : '✗ expected #f5f1eb'}`);
    console.log(`  --brand:  ${cssVars.brand}`);
    console.log(`  --df:     ${cssVars.df}`);
    console.log(`  --db:     ${cssVars.db}`);

    console.log(`\n  --- Fonts ---`);
    for (const [tag, families] of Object.entries(fonts)) {
      console.log(`  ${tag}: ${families.join(' | ')}`);
    }

    console.log(`\n  --- Colors Summary ---`);
    console.log(`  Total unique colors: ${colors.length}`);
    console.log(`  Off-palette colors: ${offPalette.length}`);
    if (offPalette.length > 0) {
      offPalette.forEach(c => console.log(`    ⚠ ${c}`));
    }

    console.log(`\n  --- Gold Mismatch (wrong #c9a84c) ---`);
    if (goldMismatch.length === 0) {
      console.log(`  ✓ No wrong gold (#c9a84c) found in computed styles`);
    } else {
      goldMismatch.forEach(h => console.log(`  ✗ ${h.tag}.${h.class} [${h.property}] = ${h.value}`));
    }

    console.log(`\n  --- Buttons (${buttons.length} found) ---`);
    buttons.forEach((b, i) => {
      console.log(`  [${i}] <${b.tag}> "${b.text}"`);
      console.log(`       class: ${b.class}`);
      console.log(`       bg: ${b.backgroundColor}, color: ${b.color}`);
      console.log(`       radius: ${b.borderRadius}, padding: ${b.padding}`);
      console.log(`       font: ${b.fontSize} ${b.fontWeight} ${b.fontFamily}`);
    });

    await page.close();
  }

  await browser.close();

  // 6. Check source CSS for wrong gold
  console.log('\n\n========== SOURCE CSS ANALYSIS ==========');
  const fs = require('fs');
  const path = require('path');
  const stylesDir = process.env.STYLES_DIR || '.';

  // Search for #c9a84c in all CSS/TSX/JSX files
  function searchFiles(dir, ext, pattern) {
    const hits = [];
    try {
      const files = fs.readdirSync(dir, { recursive: true });
      for (const file of files) {
        const fp = path.join(dir, file.toString());
        try {
          const stat = fs.statSync(fp);
          if (stat.isFile() && ext.some(e => fp.endsWith(e))) {
            const content = fs.readFileSync(fp, 'utf8');
            const lines = content.split('\n');
            lines.forEach((line, i) => {
              if (line.toLowerCase().includes(pattern.toLowerCase())) {
                hits.push({ file: fp, line: i + 1, content: line.trim() });
              }
            });
          }
        } catch {}
      }
    } catch {}
    return hits;
  }

  const srcDir = process.env.SRC_DIR || '/Users/admin/.cyrus/worktrees/VID3-413/public-v2/src';
  const wrongGoldHits = searchFiles(srcDir, ['.css', '.tsx', '.jsx', '.ts', '.js'], '#c9a84c');
  console.log(`\n  Files containing wrong gold (#c9a84c):`);
  if (wrongGoldHits.length === 0) {
    console.log('  ✓ None found');
  } else {
    wrongGoldHits.forEach(h => console.log(`  ✗ ${h.file}:${h.line} → ${h.content}`));
  }

  const correctGoldHits = searchFiles(srcDir, ['.css', '.tsx', '.jsx', '.ts', '.js'], '#a28657');
  console.log(`\n  Files containing correct gold (#a28657):`);
  correctGoldHits.forEach(h => console.log(`  ✓ ${h.file}:${h.line} → ${h.content}`));

  // Final summary
  console.log('\n\n========== FINAL SUMMARY ==========');
  for (const [pg, data] of Object.entries(results)) {
    if (data.error) {
      console.log(`\n${pg}: ERROR - ${data.error}`);
      continue;
    }
    console.log(`\n${pg}:`);
    console.log(`  CSS vars OK: teal=${data.cssVars.teal === '#194445'}, gold=${data.cssVars.gold === '#a28657'}, canvas=${data.cssVars.canvas === '#f5f1eb'}`);
    console.log(`  Off-palette colors: ${data.colors.offPalette.length}`);
    console.log(`  Wrong gold elements: ${data.goldMismatch.length}`);
    console.log(`  Buttons: ${data.buttons.length}`);
  }

  // Write JSON for further analysis
  fs.writeFileSync('/tmp/design-audit-results.json', JSON.stringify(results, null, 2));
  console.log('\nFull results written to /tmp/design-audit-results.json');
})();
