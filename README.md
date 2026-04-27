# earlybird-shop-monitoring

Daily automated monitoring for [earlybird-coffee.de](https://earlybird-coffee.de).

For every product variant in the `kaffee` collection it verifies:

1. **Availability** – `variant.available` from
2.    `https://earlybird-coffee.de/collections/kaffee/products.json?limit=250`
3.   must be `true`.
4.   2. **Add to cart** – `POST /cart/add.js` with
     3.    `{ "id": VARIANT_ID, "quantity": 1 }` must return a valid JSON line
     4.   item (real functional smoke test).
  
     5.   If any variant is unavailable or fails the cart-add check, the GitHub
     6.   Actions job exits with code `1` and the run is marked red.
  
     7.   ## Why Playwright?
  
     8.   The shop is fronted by a Cloudflare-style WAF that returns
     9.   `HTTP 429` and an HTML "Verifying your connection..." interstitial when
     10.   called from plain `node-fetch` / `curl`. The script therefore drives a
     11.   real headless Chromium via Playwright so requests carry valid cookies
     12.   and a real TLS fingerprint.
  
     13.   ## Rate-limit handling
  
     14.   After ~10 cart writes from a single IP the WAF starts blocking with
     15.   `429`. The script handles this by:
  
     16.   - Running the cart-add tests in **batches of 4** with a 12 s cooldown
           -   + page re-warm between batches.
               + - Treating `429` / interstitial responses as **soft skips** (logged but
                 -   not counted as failures). Genuinely broken variants (real `4xx/5xx`
                 -     with a JSON error) are still counted as hard failures.
                 - - Stopping the cart-add probes after several consecutive WAF blocks to
                   -   avoid wasting CI minutes.
                  
                   -   The product availability check (step 1) runs against `products.json`
                   -   once and is unaffected.
                  
                   -   ## Schedule
                  
                   -   `.github/workflows/shop-monitoring.yml` runs:
                  
                   -   - daily at `06:00` UTC
                       - - on demand via the **Run workflow** button in the Actions tab.
                        
                         - ## Files
                        
                         - | File | Purpose |
                         - | --- | --- |
                         - | `test.js` | Monitoring script (Playwright + Shopify endpoints) |
                         - | `package.json` | Pins the `playwright` dependency |
                         - | `.github/workflows/shop-monitoring.yml` | Scheduled GitHub Actions job |
                        
                         - ## Local run
                        
                         - ```bash
                           npm install
                           npx playwright install --with-deps chromium
                           npm test
                           ```

                           Exit code `0` = all good, `1` = at least one variant is not orderable.
                           
