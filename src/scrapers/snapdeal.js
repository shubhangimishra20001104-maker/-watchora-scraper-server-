/**
 * Scrapes Snapdeal's search results for a query — same real-headless-Chrome
 * approach as `amazon.js`; see that file's doc comment for the overall
 * rationale.
 */
async function scrapeSnapdeal(browser, query) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    );
    await page.setViewport({ width: 1366, height: 900 });

    const url = `https://www.snapdeal.com/search?keyword=${encodeURIComponent(query)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    await page.waitForSelector('.product-tuple-listing', { timeout: 15_000 }).catch(() => null);

    const candidates = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.product-tuple-listing')).slice(0, 48);

      return cards
        .map((card) => {
          const imgEl = card.querySelector('img.product-image');
          const priceEl = card.querySelector('.product-price');
          const linkEl = card.querySelector('a.dp-widget-link');

          const title = imgEl ? imgEl.getAttribute('title') : null;
          const priceText = priceEl ? priceEl.textContent.trim() : null;
          const href = linkEl ? linkEl.getAttribute('href') : null;

          return { title, priceText, href };
        })
        .filter((c) => c.title && c.priceText);
    });

    return candidates.map((c) => ({
      title: c.title,
      priceText: c.priceText,
      url: c.href ? new URL(c.href, 'https://www.snapdeal.com').toString() : url,
      rating: null,
    }));
  } finally {
    await page.close();
  }
}

module.exports = { scrapeSnapdeal };
