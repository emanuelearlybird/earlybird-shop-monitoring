// Shop Monitoring – earlybird-coffee.de
//
// The shop is fronted by a bot/CDN protection layer that returns an HTML
// "Verifying your connection..." interstitial (and HTTP 429) when called
// too aggressively. We therefore:
//   1) Drive a real Chromium via Playwright (cookies + JS challenge passed)
//   2) Throttle requests and retry with exponential backoff on 429/HTML.
//
// What is checked:
//   GET  /collections/<handle>/products.json?limit=250  -> all variants
//   For each variant:
//     POST /cart/clear.js
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

// Throttling
const VARIANT_DELAY_MS = 750;     // delay between variants
const MAX_RETRIES = 4;            // retries per request on rate-limit
const RETRY_BASE_MS = 2000;       // base for exponential backoff

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRealContent(page) {
      // Bot-protection layers serve an interstitial titled
  // "Verifying your connection...". Wait until the real shop is loaded.
  const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
              const title = await page.title().catch(() => '');
              if (!/verify|verifying|just a moment/i.test(title)) return;
              await page.waitForTimeout(1000);
      }
}

// Run one fetch inside the page context. Returns { status, ok, body, text }.
async function pageFetch(page, url, init) {
      return page.evaluate(
              async ({ u, opts }) => {
                        const r = await fetch(u, {
                                    credentials: 'include',
                                    ...opts,
                                    headers: { Accept: 'application/json', ...(opts && opts.headers) }
                        });
                        const text = await r.text();
                        let body = null;
                        try { body = JSON.parse(text); } catch (_) {}
                        return { status: r.status, ok: r.ok, body, text: text.slice(0, 200) };
              },
          { u: url, opts: init || {} }
            );
}

// Detect a CDN bot-protection interstitial response.
function looksBlocked(res) {
      if (res.status === 429) return true;
      if (!res.body && /verifying your connection|just a moment|<!DOCTYPE/i.test(res.text)) return true;
      return false;
}

async function withRetry(fn, label) {
      let lastRes = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
              const res = await fn();
              lastRes = res;
              if (!looksBlocked(res)) return res;
              const wait = RETRY_BASE_MS * Math.pow(2, attempt - 1);
              console.log(
                        `  retry ${attempt}/${MAX_RETRIES} after ${wait}ms ` +
                        `(${label} -> status ${res.status})`
                      );
              await sleep(wait);
      }
      return lastRes;
}

async function fetchProducts(page) {
      const url = `${SHOP_URL}/collections/${COLLECTION}/products.json?limit=250`;
      const res = await withRetry(
              () => pageFetch(page, url),
              'products.json'
            );
      if (!res.ok || !res.body) {
              throw new Error(
                        `products.json failed (status ${res.status}): ${res.text}`
                      );
      }
      return res.body.products || [];
}

async function clearCart(page) {
      await withRetry(
              () => pageFetch(page, `${SHOP_URL}/cart/clear.js`, { method: 'POST' }),
              'cart/clear.js'
            );
}

async function addVariant(page, variantId) {
      return withRetry(
              () =>
                        pageFetch(page, `${SHOP_URL}/cart/add.js`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: variantId, quantity: 1 })
                        }),
              `cart/add.js id=${variantId}`
            );
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

   try {
           console.log(`Warming up: ${SHOP_URL}/collections/${COLLECTION}`);
           await page.goto(`${SHOP_URL}/collections/${COLLECTION}`, {
                     waitUntil: 'domcontentloaded',
                     timeout: 60000
           });
           await waitForRealContent(page);

        console.log('Loading products.json ...');
           const products = await fetchProducts(page);
           console.log(`Found ${products.length} products`);
           if (products.length === 0) {
                     throw new Error('products.json returned 0 products');
           }

        let totalVariants = 0;
           for (const product of products) {
                     for (const variant of product.variants || []) {
                                 totalVariants++;
                                 const label = `${product.title} / ${variant.title} (id ${variant.id})`;

                       if (variant.available === false) {
                                     const msg = `${label}: variant.available === false`;
                                     console.log(`FAIL: ${msg}`);
                                     failures.push(msg);
                                     continue;
                       }

                       try {
                                     await clearCart(page);
                                     const res = await addVariant(page, variant.id);

                                   // /cart/add.js returns the added line item (object with .id)
                                   // or { items: [...] } depending on Shopify config.
                                   const addedOk =
                                                   res.ok &&
                                                   res.body &&
                                                   (res.body.id || Array.isArray(res.body.items));

                                   if (addedOk) {
                                                   console.log(`OK:   ${label}`);
                                   } else {
                                                   const detail = res.body
                                                     ? JSON.stringify(res.body).slice(0, 200)
                                                                     : res.text;
                                                   const msg = `${label}: add.js status ${res.status} ${detail}`;
                                                   console.log(`FAIL: ${msg}`);
                                                   failures.push(msg);
                                   }
                       } catch (err) {
                                     const msg = `${label}: exception ${err && err.message}`;
                                     console.log(`FAIL: ${msg}`);
                                     failures.push(msg);
                       }

                       await sleep(VARIANT_DELAY_MS);
                     }
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
