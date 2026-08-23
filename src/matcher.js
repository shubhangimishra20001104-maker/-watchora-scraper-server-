/**
 * Minimal reimplementation of Watchora's `ProductMatcher` confidence
 * scoring, kept here so this standalone server has no dependency on the
 * extension's source tree. Scores how well a candidate's scraped title
 * matches the user's free-text query, 0-100 — see the extension's
 * `src/services/product-matcher.service.ts` for the original/fuller
 * version this is intentionally a lightweight port of.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'with', 'for', 'and', 'of', 'in', 'on', 'new', 'best',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    // Strip display-size measurements like "16.63 cm (6.5″)" before
    // anything else — otherwise "16.63" splits into the standalone token
    // "16", which collides with a genuine model number in the query (e.g.
    // "iPhone 16") and produces false-positive matches against unrelated
    // products that merely happen to share a screen-size digit.
    .replace(/\d+(\.\d+)?\s*(cm|mm|inch|inches|in|″|"|')\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function extractStorage(text) {
  const match = (text || '').match(/(\d+)\s?(gb|tb)/i);
  if (!match) return null;
  const value = Number(match[1]);
  return match[2].toLowerCase() === 'tb' ? value * 1024 : value;
}

/** Overlap-based score (0-100) between query and title, with a storage
 * mismatch penalty since "128GB" vs "256GB" is the single most common way
 * two otherwise-similar titles are actually different products/prices.
 *
 * Deliberately scores on *query recall* (how much of the query's own
 * tokens appear in the title) rather than plain Jaccard/union overlap —
 * real product titles are long marketing copy ("Display with Promotion up
 * to 120Hz, A19 Pro Chip...") stuffed with tokens having nothing to do
 * with the query, which dilutes a union-based score even for an exact
 * match. Recall only cares whether the query's own words are present. */
const ACCESSORY_WORDS = new Set([
  'case', 'cases', 'cover', 'covers', 'skin', 'screen', 'guard', 'protector',
  'tempered', 'glass', 'charger', 'cable', 'adapter', 'strap', 'band',
  'holder', 'stand', 'pouch', 'sticker', 'compatible', 'lens', 'back',
]);

/** Product-line variant/tier words that turn a base model into a distinct
 * (and usually differently priced) product — "iPhone 16" vs "iPhone 16 Pro
 * Max" being the canonical example, but this applies broadly across
 * electronics (e.g. "Galaxy S24" vs "Galaxy S24 Ultra"). */
const VARIANT_WORDS = new Set([
  'pro', 'max', 'plus', 'ultra', 'mini', 'lite', 'air', 'se', 'fe', 'neo',
]);

function scoreMatch(query, title) {
  const queryTokens = new Set(tokenize(query));
  const titleTokens = new Set(tokenize(title));
  if (queryTokens.size === 0 || titleTokens.size === 0) return 0;

  // Titles often hyphenate/split brand names differently than a user would
  // type them ("Fire-Boltt" -> tokens "fire" + "boltt"), so an exact query
  // token like "firebolt" never matches either half even though it's
  // clearly the same brand. Fall back to a joined-title substring check
  // (no spaces/punctuation) so these "word split differently" cases still
  // count as an overlap instead of scoring 0.
  const titleJoined = [...titleTokens].join('');

  let overlap = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token) || (token.length > 3 && titleJoined.includes(token))) {
      overlap += 1;
    }
  }
  let score = Math.round((overlap / queryTokens.size) * 100);

  const queryStorage = extractStorage(query);
  const titleStorage = extractStorage(title);
  if (queryStorage && titleStorage && queryStorage !== titleStorage) {
    score = Math.max(0, score - 40);
  }

  // Brand/product-name requirement: a shared number alone (e.g. "16") is
  // not enough — "iPhone 16" and "ColorOS 16" both contain "16" but are
  // completely unrelated products. Require every non-numeric query token
  // (the actual product name words, not measurements/counts) to also
  // appear in the title; a query number match without this is meaningless.
  const queryWords = [...queryTokens].filter((t) => !/^\d+$/.test(t));
  if (queryWords.length > 0) {
    const missingWords = queryWords.filter(
      (w) => !titleTokens.has(w) && !(w.length > 3 && titleJoined.includes(w)),
    );
    if (missingWords.length > 0) {
      score = Math.max(0, score - 60);
    }
  }

  // Model-number requirement: if the query names a specific number (e.g.
  // the "16" in "iPhone 16"), a title is only a real match if that same
  // number appears in it — "iPhone Air" or "iPhone 17" both share plenty
  // of marketing words with "iPhone 16" but are different products/prices,
  // so treat a missing/different query number as a hard mismatch rather
  // than just letting word overlap carry the score.
  const queryNumbers = [...queryTokens].filter((t) => /^\d+$/.test(t) && Number(t) < 1000);
  if (queryNumbers.length > 0) {
    const titleNumbers = [...titleTokens].filter((t) => /^\d+$/.test(t) && Number(t) < 1000);
    const hasMatchingModelNumber = queryNumbers.some((n) => titleNumbers.includes(n));
    if (!hasMatchingModelNumber) {
      score = Math.max(0, score - 60);
    }
  }

  const queryHasAccessoryWord = [...queryTokens].some((t) => ACCESSORY_WORDS.has(t));
  const titleHasAccessoryWord = [...titleTokens].some((t) => ACCESSORY_WORDS.has(t));
  if (!queryHasAccessoryWord && titleHasAccessoryWord) {
    // e.g. query "iphone 16" (the phone) must not match a listing for
    // "...Case Compatible For...iPhone 16..." (an accessory) just because
    // every query word/number happens to appear inside that longer title.
    score = Math.max(0, score - 70);
  }

  // Variant-name requirement: e.g. searching plain "iphone" or "iphone 16"
  // should not match "iPhone 16 Pro Max" or "iPhone 16 Plus" listings —
  // those are different (and differently priced) products, not the base
  // model the user actually typed. Only penalize when the title's variant
  // word wasn't itself part of the query, so a query that *does* say "pro
  // max" still matches Pro Max listings normally.
  const titleExtraVariantWords = [...titleTokens].filter(
    (t) => VARIANT_WORDS.has(t) && !queryTokens.has(t),
  );
  if (titleExtraVariantWords.length > 0) {
    score = Math.max(0, score - 70);
  }

  return score;
}

module.exports = { scoreMatch };
