// Shop Monitoring – earlybird-coffee.de
//
// Approach
// --------
// The shop is fronted by a Cloudflare-style WAF that aggressively rate-limits
// non-browser traffic. To verify availability we drive a real Chromium via
// Playwright, warm up cookies, and then hit the shop's own JSON endpoints from
// inside the page context.
//
// Behaviour
// ---------
// Hard fail (counted, exit 1):
//   - variant.available === false from products.json
//   - cart/add.js returns a JSON error (description / message field)
// Soft skip (logged, NOT counted):
//   - WAF interstitial / HTTP 429 even after retries
// Bail out:
//   - too many consecutive WAF blocks in a row -> stop, exit 1
//
// At the end, an array of structured failures is written to failures.json
// for the workflow to use in the issue body / Teams notification.

const { chromium } = require('playwright');
const fs = require('fs');

const SHOP = 'https://earlybird-coffee.de';
const COLLECTION = '/collections/kaffee';
const PRODUCTS_JSON = SHOP + COLLECTION + '/products.json?limit=250';

const BATCH_SIZE = 4;
const COOLDOWN_MS = 12000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 6000;
const MAX_CONSECUTIVE_BLOCKS = 3;

function looksBlocked(text) {
  if (typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return t.includes('verifying your connection') ||
         t.includes('just a moment') ||
         t.includes('cf-mitigated') ||
         t.includes('attention required') ||
         t.includes('<!doctype html');
}

async function waitForRealContent(page) {
  // navigate to homepage first to pick up cookies / clearance
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(SHOP + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      const html = await page.content();
      if (!looksBlocked(html)) return;
    } catch (e) {}
    await page.waitForTimeout(4000);
  }
}

async function warmUp(page) {
  await waitForRealContent(page);
  // Touch the collection too so cookies match
  try {
    await page.goto(SHOP + COLLECTION, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {}
}

async function pageFetch(page, url, init) {
  return await page.evaluate(async ({ url, init }) => {
    const res = await fetch(url, Object.assign({ credentials: 'include' }, init || {}));
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  }, { url, init });
}

async function fetchProducts(page) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await pageFetch(page, PRODUCTS_JSON);
    if (r.ok && !looksBlocked(r.text)) {
      try {
        return JSON.parse(r.text).products || [];
      } catch (e) {}
    }
    await warmUp(page);
    await page.waitForTimeout(3000);
  }
  throw new Error('Could not load products.json after multiple attempts');
}

async function addVariantOnce(page, variantId) {
  // clear cart
  await pageFetch(page, SHOP + '/cart/clear.js', { method: 'POST' });
  // add variant
  const res = await pageFetch(page, SHOP + '/cart/add.js', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ id: variantId, quantity: 1 })
  });
  return res;
}

// Returns: { kind: 'ok' | 'fail' | 'block', reason?: string }
async function checkVariant(page, variant, productTitle) {
  if (variant.available === false) {
    return { kind: 'fail', reason: 'available === false in products.json' };
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await addVariantOnce(page, variant.id);
    } catch (e) {
      if (attempt < MAX_RETRIES) { await page.waitForTimeout(RETRY_DELAY_MS); continue; }
      return { kind: 'block', reason: 'request error: ' + e.message };
    }
    if (res.status === 429 || looksBlocked(res.text)) {
      if (attempt < MAX_RETRIES) {
        await page.waitForTimeout(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      return { kind: 'block', reason: 'WAF/429 after retries' };
    }
    // try to parse JSON
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch (e) {}
    if (!parsed) {
      if (attempt < MAX_RETRIES) { await page.waitForTimeout(RETRY_DELAY_MS); continue; }
      return { kind: 'block', reason: 'non-JSON response (likely WAF)' };
    }
    if (parsed.status && parsed.status >= 400 && (parsed.description || parsed.message)) {
      return { kind: 'fail', reason: 'cart/add.js error: ' + (parsed.description || parsed.message) };
    }
    if (!res.ok) {
      return { kind: 'fail', reason: 'cart/add.js HTTP ' + res.status + ' ' + (parsed.description || parsed.message || '') };
    }
    return { kind: 'ok' };
  }
  return { kind: 'block', reason: 'unknown' };
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    locale: 'de-DE'
  });
  const page = await context.newPage();

  let exitCode = 0;
  const failures = [];   // structured fails for downstream notification
  const skipped  = [];   // soft skips (informational)
  let consecutiveBlocks = 0;

  try {
    await warmUp(page);
    const products = await fetchProducts(page);

    // Flatten all variants
    const all = [];
    for (const p of products) {
      for (const v of (p.variants || [])) {
        all.push({ product: p, variant: v });
      }
    }
    console.log('Found ' + products.length + ' products / ' + all.length + ' variants.');

    let processed = 0;
    for (let i = 0; i < all.length; i += BATCH_SIZE) {
      const batch = all.slice(i, i + BATCH_SIZE);
      for (const { product, variant } of batch) {
        processed++;
        const label = product.title + ' / ' + variant.title + ' (id ' + variant.id + ')';
        const r = await checkVariant(page, variant, product.title);
        if (r.kind === 'ok') {
          consecutiveBlocks = 0;
          console.log('OK   [' + processed + '/' + all.length + '] ' + label);
        } else if (r.kind === 'fail') {
          consecutiveBlocks = 0;
          exitCode = 1;
          failures.push({
            productTitle: product.title,
            productHandle: product.handle,
            variantId: variant.id,
            variantTitle: variant.title,
            reason: r.reason
          });
          console.log('FAIL [' + processed + '/' + all.length + '] ' + label + ' :: ' + r.reason);
        } else {
          // block / soft skip
          consecutiveBlocks++;
          skipped.push({ productTitle: product.title, variantId: variant.id, variantTitle: variant.title, reason: r.reason });
          console.log('SKIP [' + processed + '/' + all.length + '] ' + label + ' :: ' + r.reason);
          if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
            console.log('Too many consecutive WAF blocks, bailing out.');
            exitCode = 1;
            break;
          }
        }
      }
      if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) break;
      // cooldown between batches and re-warm
      if (i + BATCH_SIZE < all.length) {
        await page.waitForTimeout(COOLDOWN_MS);
        await warmUp(page);
      }
    }
  } catch (e) {
    console.error('Fatal error:', e && e.stack || e);
    exitCode = 1;
    failures.push({
      productTitle: '(monitoring system)',
      variantId: 0,
      variantTitle: 'Fatal error',
      reason: (e && e.message) ? e.message : String(e)
    });
  } finally {
    await browser.close();
  }

  // Persist structured result for downstream steps
  try {
    fs.writeFileSync('failures.json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      exitCode,
      failures,
      skippedCount: skipped.length
    }, null, 2));
  } catch (e) {
    console.error('Could not write failures.json:', e.message);
  }

  // Human-readable summary block (also picked up by the workflow if needed)
  console.log('');
  console.log('===== SUMMARY =====');
  console.log('Failures: ' + failures.length);
  for (const f of failures) {
    console.log(' - ' + f.productTitle + ' / ' + f.variantTitle + ' (id ' + f.variantId + ') :: ' + f.reason);
  }
  console.log('Soft-skipped (WAF): ' + skipped.length);
  console.log('Exit code: ' + exitCode);
  console.log('===================');

  process.exit(exitCode);
})();
