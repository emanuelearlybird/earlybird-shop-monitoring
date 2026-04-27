// Shop Monitoring – earlybird-coffee.de
//
// Why Playwright?
// The shop sits behind a bot/CDN protection layer that returns an HTML
// "Verifying your connection..." interstitial when called from plain
// Node fetch / curl. Running the requests inside a real Chromium
// (cookies, TLS fingerprint, JS challenge) makes them succeed.
//
// Strategy:
// 1. Launch headless Chromium with a realistic user agent.
// 2. Navigate to the storefront once to pass any JS challenge and
//    collect cookies.
// 3. From inside the page context, call the public Shopify endpoints:
//      GET  /collections/<handle>/products.json?limit=250
//      POST /cart/clear.js
//      POST /cart/add.js   { id: VARIANT_ID, quantity: 1 }
// 4. Aggregate failures. Exit 1 if anything is not orderable.

const { chromium } = require('playwright');

const SHOP_URL = 'https://earlybird-coffee.de';
const COLLECTION = 'kaffee';
const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36';

async function waitForRealContent(page) {
    // Some bot-protection layers serve an interstitial titled
  // "Verifying your connection...". Wait until the real shop is loaded.
  const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
          const title = await page.title().catch(() => '');
          if (!/verify|verifying|just a moment/i.test(title)) return;
          await page.waitForTimeout(1000);
    }
}

async function fetchProducts(page) {
    const url = `${SHOP_URL}/collections/${COLLECTION}/products.json?limit=250`;
    const result = await page.evaluate(async (u) => {
          const r = await fetch(u, {
                  credentials: 'include',
                  headers: { Accept: 'application/json' }
          });
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          return { status: r.status, ok: r.ok, json, text: text.slice(0, 300) };
    }, url);

  if (!result.ok || !result.json) {
        throw new Error(
                `products.json failed (status ${result.status}): ${result.text}`
              );
  }
    return result.json.products || [];
}

async function testVariant(page, variantId) {
    return page.evaluate(async ({ shop, id }) => {
          // Always start from an empty cart so the add.js result is unambiguous.
                             await fetch(`${shop}/cart/clear.js`, {
                                     method: 'POST',
                                     credentials: 'include'
                             });

                             const r = await fetch(`${shop}/cart/add.js`, {
                                     method: 'POST',
                                     credentials: 'include',
                                     headers: {
                                               'Content-Type': 'application/json',
                                               Accept: 'application/json'
                                     },
                                     body: JSON.stringify({ id, quantity: 1 })
                             });

                             const text = await r.text();
          let body = null;
          try { body = JSON.parse(text); } catch (_) {}

                             return {
                                     status: r.status,
                                     ok: r.ok,
                                     body,
                                     text: text.slice(0, 300)
                             };
    }, { shop: SHOP_URL, id: variantId });
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

                   let result;
                           try {
                                       result = await testVariant(page, variant.id);
                           } catch (err) {
                                       const msg = `${label}: exception ${err && err.message}`;
                                       console.log(`FAIL: ${msg}`);
                                       failures.push(msg);
                                       continue;
                           }

                   if (result.ok && result.body && Array.isArray(result.body.items)) {
                               console.log(`OK:   ${label}`);
                   } else if (result.ok && result.body && result.body.id) {
                               // /cart/add.js returns the added line item directly.
                             console.log(`OK:   ${label}`);
                   } else {
                               const detail = result.body
                                 ? JSON.stringify(result.body).slice(0, 300)
                                             : result.text;
                               const msg = `${label}: add.js status ${result.status} ${detail}`;
                               console.log(`FAIL: ${msg}`);
                               failures.push(msg);
                   }
                 }
         }

      console.log(`\nChecked ${totalVariants} variants total.`);
   } catch (err) {
         console.error(`Fatal error: ${err && err.stack || err}`);
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
