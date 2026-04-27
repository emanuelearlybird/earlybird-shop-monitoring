// Shop Monitoring – earlybird-coffee.de
//
// The shop is fronted by a bot/CDN protection layer that issues
// HTTP 429 + an HTML "Verifying your connection..." interstitial when
// requests come in faster than ~5 / 30s from the same IP.
//
// Strategy:
//   1) Drive a real Chromium via Playwright (cookies + JS challenge passed).
//   2) Group variants in small batches (BATCH_SIZE).
//   3) Between batches do a full page navigation back to the storefront.
//      That triggers Cloudflare to mint a fresh clearance cookie window.
//   4) Inside a batch: short delay (BATCH_INNER_DELAY_MS) per request.
//   5) On detected block, wait long, re-warm and retry up to MAX_RETRIES.
//
// We deliberately do NOT call /cart/clear.js for every variant – that
// would double the request count and trip the rate limit. Adding the
// same line item twice still returns a successful JSON response from
// /cart/add.js (Shopify just bumps the quantity), which is what we
// care about: "is this variant orderable right now?".
//
// What is checked:
//   GET  /collections/<handle>/products.json?limit=250  -> all variants
//   For each variant:
//     POST /cart/add.js   { id: VARIANT_ID, quantity: 1 }
//
// Failure conditions:
//   - variant.available === false in products.json
//   - cart/add.js does not return a valid JSON line item after retries
// Exit 1 on any failure, 0 otherwise.

const { chromium } = require('playwright');

const SHOP_URL = 'https://earlybird-coffee.de';
const COLLECTION = 'kaffee';
const USER_AGENT =
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36';

// Pacing tuned to the observed limit (~5 requests / 30s before a 429).
const BATCH_SIZE = 4;                // safe number of cart calls per warm window
const BATCH_INNER_DELAY_MS = 1500;   // small delay between requests within a batch
const BATCH_COOLDOWN_MS = 8000;      // wait between batches before re-warming
const RECOVERY_WAIT_MS = 25000;      // pause after a hard block before recovery
const MAX_RETRIES = 3;               // recovery attempts per failed variant

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRealContent(page) {
          const deadline = Date.now() + 45000;
          while (Date.now() < deadline) {
                      const title = await page.title().catch(() => '');
                      if (title && !/verify|verifying|just a moment/i.test(title)) return;
                      await page.waitForTimeout(1000);
          }
}

async function warmUp(page) {
          await page.goto(`${SHOP_URL}/collections/${COLLECTION}`, {
                      waitUntil: 'domcontentloaded',
                      timeout: 60000
          });
          await waitForRealContent(page);
}

async function pageFetch(page, url, init) {
          return page.evaluate(
                      async ({ u, opts }) => {
                                    try {
                                                    const r = await fetch(u, {
                                                                      credentials: 'include',
                                                                      ...opts,
                                                                      headers: { Accept: 'application/json', ...(opts && opts.headers) }
                                                    });
                                                    const text = await r.text();
                                                    let body = null;
                                                    try { body = JSON.parse(text); } catch (_) {}
                                                    return { status: r.status, ok: r.ok, body, text: text.slice(0, 200) };
                                    } catch (e) {
                                                    return { status: 0, ok: false, body: null, text: String(e).slice(0, 200) };
                                    }
                      },
                  { u: url, opts: init || {} }
                    );
}

function looksBlocked(res) {
          if (!res) return true;
          if (res.status === 429 || res.status === 403 || res.status === 503) return true;
          if (!res.body && /verifying your connection|just a moment|<!DOCTYPE/i.test(res.text)) return true;
          return false;
}

async function fetchProducts(page) {
          const url = `${SHOP_URL}/collections/${COLLECTION}/products.json?limit=250`;
          let res;
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                      res = await pageFetch(page, url);
                      if (!looksBlocked(res) && res.ok && res.body) return res.body.products || [];
                      console.log(`  products.json blocked (status ${res.status}), recovery ${attempt + 1}/${MAX_RETRIES}`);
                      await sleep(RECOVERY_WAIT_MS);
                      try { await warmUp(page); } catch (_) {}
          }
          throw new Error(`products.json failed after retries (status ${res && res.status}): ${res && res.text}`);
}

async function addVariant(page, variantId) {
          return pageFetch(page, `${SHOP_URL}/cart/add.js`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ id: variantId, quantity: 1 })
          });
}

async function checkVariant(page, variantId, label) {
          for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
                      const res = await addVariant(page, variantId);
                      const ok =
                                    res &&
                                    res.ok &&
                                    res.body &&
                                    (res.body.id || Array.isArray(res.body.items));
                      if (ok) return { ok: true, res };
                      if (!looksBlocked(res)) return { ok: false, res }; // genuine failure, not a block
            if (attempt > MAX_RETRIES) return { ok: false, res };
                      console.log(
                                    `  blocked on ${label} (status ${res.status}), recovery ${attempt}/${MAX_RETRIES}: ` +
                                    `waiting ${RECOVERY_WAIT_MS}ms then re-warming...`
                                  );
                      await sleep(RECOVERY_WAIT_MS);
                      try { await warmUp(page); } catch (_) {}
          }
}

(async () => {
          const browser = await chromium.launch({
                      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
          });
          const context = await browser.newContext({
                      userAgent: USER_AGENT,
                      locale: 'de-DE',
                      extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' }
          });
          const page = await context.newPage();

   const failures = [];
          let totalVariants = 0;

   try {
               console.log(`Warming up: ${SHOP_URL}/collections/${COLLECTION}`);
               await warmUp(page);

            console.log('Loading products.json ...');
               const products = await fetchProducts(page);
               console.log(`Found ${products.length} products`);
               if (products.length === 0) {
                             throw new Error('products.json returned 0 products');
               }

            // Flatten variants for easy batching
            const all = [];
               for (const product of products) {
                             for (const variant of product.variants || []) {
                                             all.push({ product, variant });
                             }
               }
               totalVariants = all.length;
               console.log(`Total variants to check: ${totalVariants}`);

            let inBatch = 0;
               for (const { product, variant } of all) {
                             const label = `${product.title} / ${variant.title} (id ${variant.id})`;

                 if (variant.available === false) {
                                 const msg = `${label}: variant.available === false`;
                                 console.log(`FAIL: ${msg}`);
                                 failures.push(msg);
                                 continue;
                 }

                 // Cool down + re-warm at the start of each new batch (except first).
                 if (inBatch >= BATCH_SIZE) {
                                 console.log(`-- batch cooldown (${BATCH_COOLDOWN_MS}ms) + re-warm --`);
                                 await sleep(BATCH_COOLDOWN_MS);
                                 try { await warmUp(page); } catch (_) {}
                                 inBatch = 0;
                 }

                 try {
                                 const { ok, res } = await checkVariant(page, variant.id, label);
                                 if (ok) {
                                                   console.log(`OK:   ${label}`);
                                 } else {
                                                   const detail = res && res.body
                                                     ? JSON.stringify(res.body).slice(0, 200)
                                                                       : (res ? res.text : 'no response');
                                                   const status = res ? res.status : '?';
                                                   const msg = `${label}: add.js status ${status} ${detail}`;
                                                   console.log(`FAIL: ${msg}`);
                                                   failures.push(msg);
                                 }
                 } catch (err) {
                                 const msg = `${label}: exception ${err && err.message}`;
                                 console.log(`FAIL: ${msg}`);
                                 failures.push(msg);
                 }

                 inBatch++;
                             await sleep(BATCH_INNER_DELAY_MS);
               }

            console.log(`\nChecked ${totalVariants} variants total.`);
   } catch (err) {
               console.error(`Fatal error: ${err && (err.stack || err.message) || err}`);
               failures.push(`fatal: ${err && err.message || err}`);
   } finally {
               await browser.close().catch(() => {});
   }

   if (failures.length > 0) {
               console.log(`\n${failures.length} failure(s):`);
               for (const f of failures) console.log(`- ${f}`);
               process.exit(1);
   }

   console.log('\nAll variants are orderable.');
          process.exit(0);
})();
