import { load } from "cheerio";

import {
  decodeBase64Url,
  flattenPayloadParts,
  getHeaderValue,
} from "./gmail.js";
import { STORES } from "./stores.js";

const ORDER_KEYWORDS = [
  "order",
  "ordered",
  "order confirmed",
  "your order",
  "shipment",
  "shipped",
  "dispatch",
  "delivered",
  "item delivered",
  "invoice",
  "return pickup",
  "exchange pickup",
  "package delivered",
];


export function analyzeCommerceMessage(message) {
  const payload = message.payload;
  const subject = getHeaderValue(payload, "subject");
  const from = getHeaderValue(payload, "from");
  const dateHeader = getHeaderValue(payload, "date");
  const internalDate = message.internalDate ? Number(message.internalDate) : undefined;
  const snippet = message.snippet ?? "";
  const { html, text } = extractMessageBodies(payload);
  const store = detectStore({ from, subject, snippet, html, text });

  if (!store) {
    return buildRejectedResult(message, { subject, from, dateHeader, internalDate }, "unknown_store");
  }

  const headers = payload?.headers ?? [];
  const orderCheck = inspectTransactionalMail({ subject, snippet, from, html, text, store, headers });
  if (!orderCheck.matches) {
    return buildRejectedResult(message, { subject, from, dateHeader, internalDate, store }, orderCheck.reason);
  }

  const items = extractPurchasedItems({ html, text, subject, snippet, store });
  if (items.length === 0) {
    return buildRejectedResult(message, { subject, from, dateHeader, internalDate, store }, "no_items_extracted", true);
  }

  return {
    parsed: {
      store: store.id,
      messageId: message.id,
      threadId: message.threadId,
      subject,
      from,
      date: internalDate ? new Date(internalDate).toISOString() : dateHeader || null,
      snippet,
      items,
    },
    debug: {
      store: store.id,
      messageId: message.id,
      threadId: message.threadId,
      subject,
      from,
      date: internalDate ? new Date(internalDate).toISOString() : dateHeader || null,
      matchedOrderMail: true,
      rejectionReason: null,
      itemCount: items.length,
    },
  };
}

function buildRejectedResult(message, { subject, from, dateHeader, internalDate, store }, reason, matchedOrderMail = false) {
  return {
    parsed: null,
    debug: {
      store: store?.id ?? null,
      messageId: message.id,
      threadId: message.threadId,
      subject,
      from,
      date: internalDate ? new Date(internalDate).toISOString() : dateHeader || null,
      matchedOrderMail,
      rejectionReason: reason,
      itemCount: 0,
    },
  };
}

function detectStore({ from, subject, snippet, html, text }) {
  const senderHaystack = `${from}`;
  const contentHaystack = `${subject} ${snippet} ${stripHtml(html ?? "").slice(0, 5000)} ${text ?? ""}`;

  const senderMatched = STORES.find((store) =>
    store.senderPatterns.some((pattern) => pattern.test(senderHaystack)),
  );
  if (senderMatched) {
    return senderMatched;
  }

  return STORES.find((store) =>
    (store.mentionPatterns ?? []).some((pattern) => pattern.test(contentHaystack)),
  ) ?? null;
}

// Weighted structural scorer: signals are architectural properties of the two
// email types, not vocabulary. Structure changes across platform rewrites
// (years), not template refreshes (months). No per-store configuration needed.
function inspectTransactionalMail({ subject, snippet, from, html, text, headers }) {
  const headerHaystack = `${subject} ${snippet} ${from}`.toLowerCase();
  const plainText = text ?? "";
  const bodyText = stripHtml(html ?? "").slice(0, 16000);
  const combined = `${headerHaystack} ${plainText} ${bodyText}`.toLowerCase();

  const hasOrderKeyword = ORDER_KEYWORDS.some((keyword) => combined.includes(keyword));
  if (!hasOrderKeyword) {
    return { matches: false, reason: "missing_order_keyword" };
  }

  let score = 0;

  // --- Positive signals: structurally required in any actionable order email ---

  // Structured identifier: order/invoice/tracking ID with a value
  if (/\b(order|invoice|tracking|packet)\s*(id|no\.?|number|#)\s*:?\s*[a-z0-9][a-z0-9\-]{3,}/i.test(combined)) {
    score += 4;
  }

  // Indian 6-digit PIN code in delivery address context
  if (/\b[1-9][0-9]{5}\b/.test(combined)) {
    score += 3;
  }

  // Price breakdown: two or more price amounts (Subtotal, Tax, Total, MRP…)
  const priceMatches = combined.match(/(?:[₹]|\brs\.?)\s*\d[\d,]*/gi) ?? [];
  if (priceMatches.length >= 2) {
    score += 2;
  }

  // Transactional structural markers (strong positive)
  if (
    /delivery address/i.test(combined) ||
    /billing details/i.test(combined) ||
    /shipping address/i.test(combined) ||
    /delivery service provider/i.test(combined) ||
    /order item detail/i.test(combined) ||
    /sold by/i.test(combined)
  ) {
    score += 3;
  }

  // Qty/size typically appear in order item tables
  if (/\bqty\b/i.test(combined) || (/\bsize\b/i.test(combined) && /\bseller\b/i.test(combined))) {
    score += 2;
  }

  // RFC 3834 Auto-Submitted header: set on automated transactional notifications
  const autoSubmitted = headers.find((h) => h.name?.toLowerCase() === "auto-submitted")?.value ?? "";
  if (/auto-generated|auto-replied/i.test(autoSubmitted)) {
    score += 2;
  }

  // --- Negative signals: promotional email markers ---

  // CTA button saturation: 5+ links containing promotional action verbs
  if (html) {
    const $ = load(html);
    const ctaCount = $("a").filter((_, el) => {
      const text = $(el).text().toLowerCase();
      return /\b(shop now|buy now|claim|redeem|get offer|view offer|browse|explore)\b/.test(text);
    }).length;
    if (ctaCount >= 5) score -= 4;
    else if (ctaCount >= 3) score -= 2;

    // Image-to-text ratio: marketing emails are image-heavy
    const imgCount = $("img").length;
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
    if (wordCount > 0 && imgCount / wordCount > 0.1) score -= 3;
  }

  // Standard bulk-send headers (weak signal — Indian stores may omit)
  const hasListUnsubscribe = headers.some((h) => h.name?.toLowerCase() === "list-unsubscribe");
  if (hasListUnsubscribe) score -= 2;

  const precedence = headers.find((h) => h.name?.toLowerCase() === "precedence")?.value ?? "";
  if (/bulk|list/i.test(precedence)) score -= 2;

  if (score < 0) {
    return { matches: false, reason: "structural_score" };
  }

  // Legacy hard gate: must have at least one transactional marker (keeps precision
  // high even when the scorer alone is ambiguous)
  const hasTransactionalMarker = score > 0 ||
    /order\s*(id|number|no\.?)/i.test(combined) ||
    /packet\s*number/i.test(combined) ||
    /tracking\s*(id|number)/i.test(combined) ||
    /invoice/i.test(combined) ||
    /qty\b/i.test(combined) ||
    /seller/i.test(combined);

  if (!hasTransactionalMarker) {
    return { matches: false, reason: "missing_transactional_marker" };
  }

  return { matches: true, reason: null };
}

function extractMessageBodies(payload) {
  const parts = flattenPayloadParts(payload);
  let html = "";
  let text = "";

  for (const part of parts) {
    const mimeType = part.mimeType?.toLowerCase();
    const bodyData = part.body?.data;
    if (!bodyData) {
      continue;
    }

    if (!html && mimeType === "text/html") {
      html = decodeBase64Url(bodyData);
    }

    if (!text && mimeType === "text/plain") {
      text = decodeBase64Url(bodyData);
    }
  }

  if (!html && payload?.body?.data) {
    html = decodeBase64Url(payload.body.data);
  }

  return { html, text };
}

function extractPurchasedItems({ html, text, subject, snippet, store }) {
  const candidates = [];

  if (html) {
    candidates.push(...extractFromHtml(html, store, subject));
  }

  if (text) {
    candidates.push(...extractFromText(text, store, subject));
  }

  return normalizeCandidates(candidates, { subject, snippet });
}

function extractFromHtml(html, store, subject) {
  const $ = load(html);
  const products = new Map();
  $("img[src], img[data-src]").each((_, element) => {
    const candidate = extractCandidateFromImage($, element, store, subject);
    if (!candidate) {
      return;
    }

    const key = candidate.productUrl ?? candidate.imageUrl ?? candidate.name;
    if (!products.has(key)) {
      products.set(key, candidate);
    } else {
      mergeMissing(products.get(key), candidate);
    }
  });

  return [...products.values()];
}

function extractCandidateFromImage($, element, store, subject) {
  const image = $(element);

  // Dimension pre-filter: avatars, badges, icons, and banners are not products.
  // Product images are roughly portrait/square (100–600 px tall).
  // This is structural — dimensions are architectural decisions, not email content.
  const width = Number.parseInt(image.attr("width") ?? "", 10);
  const height = Number.parseInt(image.attr("height") ?? "", 10);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    if (width < 80 && height < 80) return null;        // icon / avatar
    if (width > 0 && height > 0 && width / height > 4) return null;  // landscape banner
  }

  const imageUrl = bestImageUrl([image.attr("src"), image.attr("data-src")], store);
  if (!imageUrl) {
    return null;
  }

  const container = findBestContainer($, image, store);
  if (!container) {
    return null;
  }

  const productUrl = findNearestProductUrl($, image, container, store);
  const name = findBestProductName($, image, container, subject);
  if (!name) {
    return null;
  }

  return {
    name,
    productUrl,
    imageUrl,
  };
}

function extractFromText(text, store, subject) {
  const candidates = [];
  const productUrls = extractUrls(text).filter((url) => isLikelyProductUrl(url, store));
  const imageUrls = extractUrls(text).filter((url) => isLikelyImageUrl(url, store));
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const productUrl of productUrls) {
    const matchingLineIndex = lines.findIndex((line) => line.includes(productUrl));
    const nearbyText = lines.slice(Math.max(0, matchingLineIndex - 2), matchingLineIndex + 4).join(" ");
    const name = chooseBestName([nearbyText.replace(productUrl, ""), subject]);
    if (!name) {
      continue;
    }

    candidates.push({
      name,
      productUrl,
      imageUrl: imageUrls.find((url) => url.includes(extractSlug(productUrl))),
    });
  }

  return candidates;
}

function normalizeCandidates(candidates, { subject, snippet }) {
  return candidates
    .map((candidate) => ({
      name: cleanProductName(candidate.name) || cleanProductName(snippet) || cleanProductName(subject) || null,
      productUrl: cleanUrl(candidate.productUrl),
      imageUrl: cleanUrl(candidate.imageUrl),
    }))
    .filter((candidate) => candidate.imageUrl && candidate.name)
}

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanName(value) {
  if (!value) {
    return "";
  }

  return value
    .replace(/\s+/g, " ")
    .replace(/[|]+/g, " ")
    .replace(/\b(?:shop now|view item|buy now|track order|return details)\b/gi, "")
    .trim();
}

function cleanProductName(value) {
  const cleaned = cleanName(value);
  if (!cleaned) {
    return "";
  }

  return cleaned
    .replace(/\b(?:size|qty|quantity|colour|color|price|mrp|amount|total)\b[\s\S]*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function findBestContainer($, image, store) {
  const containerSelectors = ["a", "td", "div", "li", "tr", "table"];
  const candidates = [];

  for (const selector of containerSelectors) {
    let current = image.closest(selector);
    let depth = 0;
    while (current.length > 0 && depth < 4) {
      const text = cleanName(current.text());
      const imageCount = current.find("img").length;
      const productLinkCount = current.find("a[href]").map((_, link) => $(link).attr("href")).get()
        .filter((href) => isLikelyProductUrl(cleanUrl(href), store)).length;
      const score = scoreContainer(text, imageCount, productLinkCount);
      if (score > 0) {
        candidates.push({ current, score });
      }
      current = current.parent().closest(selector);
      depth += 1;
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.current ?? null;
}

function scoreContainer(text, imageCount, productLinkCount) {
  if (!text) {
    return -Infinity;
  }

  let score = 0;
  const length = text.length;
  if (length >= 10 && length <= 300) score += 3;
  if (length > 300 && length <= 700) score += 1;
  if (length > 900) score -= 4;
  if (imageCount >= 1 && imageCount <= 3) score += 3;
  if (imageCount > 4) score -= 3;
  if (productLinkCount >= 1) score += 2;

  // Purchase-context signals: these labels appear in order item tables across
  // any e-commerce store (universal), steering selection away from social /
  // recommendation sections that lack structured purchase data.
  if (/\b(size|qty|quantity|colour|color|seller|sold by)\s*:/i.test(text)) score += 5;
  if (/[₹]\s*\d/.test(text)) score += 3;
  if (/\b(shop now|view all|claim offer|redeem|get offer)\b/i.test(text)) score -= 4;

  return score;
}

function findNearestProductUrl($, image, container, store) {
  const directLink = firstMatchingUrl(
    [image.closest("a[href]").attr("href")],
    (value) => isLikelyProductUrl(value, store),
  );
  if (directLink) {
    return directLink;
  }

  return firstMatchingUrl(
    container.find("a[href]").map((_, link) => $(link).attr("href")).get(),
    (value) => isLikelyProductUrl(value, store),
  );
}

function findBestProductName($, image, container, subject) {
  // Product images in order emails are rendered from the product catalog, which
  // consistently populates alt text with the product name. Non-product images
  // (influencer avatars, brand logos) have empty or person/brand alt text.
  // Try alt text first; skip DOM traversal entirely if it scores well enough.
  const altText = cleanProductName(image.attr("alt") ?? "");
  if (altText && scoreName(altText) > 4) {
    return altText;
  }

  const candidates = [];

  candidates.push({ text: image.attr("title"), bonus: -1 });
  candidates.push({ text: image.closest("a[href]").text(), bonus: 1 });
  candidates.push({ text: image.parent().text(), bonus: 3 });
  candidates.push({ text: image.closest("td").text(), bonus: 3 });
  candidates.push({ text: image.closest("td").siblings().text(), bonus: 5 });
  candidates.push({ text: image.closest("tr").text(), bonus: 2 });
  candidates.push({ text: image.closest("table").text(), bonus: 1 });
  candidates.push({ text: image.closest("li").text(), bonus: 3 });
  candidates.push({ text: image.closest("div").text(), bonus: 2 });
  candidates.push({ text: subjectSegment(subject), bonus: -1 });

  let current = image.parent();
  let depth = 0;
  while (current.length > 0 && depth < 6) {
    const bonus = Math.max(0, 4 - depth);
    candidates.push({ text: current.text(), bonus });
    candidates.push({ text: current.siblings().text(), bonus: bonus + 1 });
    current = current.parent();
    depth += 1;
  }

  container.find("span, p, td, div, a, h1, h2, h3, h4").each((_, element) => {
    candidates.push({ text: $(element).text(), bonus: 1 });
  });

  candidates.push({ text: container.text(), bonus: 0 });

  // Fall back to alt text at a lower bonus if DOM traversal also finds nothing
  candidates.push({ text: image.attr("alt"), bonus: -2 });

  return chooseBestName(candidates);
}

function chooseBestName(values) {
  const scored = values
    .map((entry) => ({
      value: cleanProductName(typeof entry === "string" ? entry : entry.text),
      bonus: typeof entry === "string" ? 0 : (entry.bonus ?? 0),
    }))
    .filter((entry) => entry.value)
    .map((entry) => ({ value: entry.value, score: scoreName(entry.value) + entry.bonus }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.value ?? "";
}

function scoreName(value) {
  const normalized = value.toLowerCase();

  // Universal semantic disqualifiers — each pattern represents a category of
  // text that appears structurally in any retail email but is never a product
  // name. None of these are store-specific observations.

  // Social proof widgets: embedded brand/influencer follower counts
  // (appear in Myntra, Nykaa, Meesho brand sections and any store with
  // influencer marketing — digits may be concatenated with name by DOM join)
  if (/\d+(?:\.\d+)?[km]?\s*followers?\b/i.test(value)) return -10;

  // Personalised greeting: every retail transactional email opens with one
  if (/^(hello|hi|hey|dear)\s+\w/i.test(value)) return -10;

  // Delivery ETA: courier-integrated stores (Delhivery, Ekart, Xpressbees)
  // inject arrival time near the product image
  if (/\b\d{1,2}:\d{2}\s*(am|pm)\b/i.test(value)) return -8;

  // Code/CSS/JS leakage: happens when a script/style block is not fully
  // stripped before text extraction — a parser artefact, not store-specific
  if (/[{}[\]]/.test(value) || /\bfunction\s*\(/.test(value)) return -10;

  // Status / UI lines that DOM-join often merges with product titles (e.g.
  // "Order Delivered - Women Dress"). Do NOT use a blanket \b(order)\b check —
  // it rejects legitimate copy and hits product names like "Track Pants".
  const trimmed = normalized.trim();
  if (
    /^(partial\s+)?order\s+(delivered|shipped|confirmed|placed|dispatched)\b/i.test(trimmed) ||
    /^(out\s+for\s+delivery|item\(s\)\s+delivered|delivery\s+address|billing\s+details|order\s+details|order\s+summary)\b/i.test(trimmed) ||
    /^(track(ing)?\s+(order|shipment|package)|view\s+order|contact\s+us)\b/i.test(trimmed) ||
    /^(return\s+(pickup|details|request)|refund\s+(initiated|details))\b/i.test(trimmed)
  ) {
    return -4;
  }

  // Date-only strings and day-of-week lines (e.g. "Mon, 10 Jan")
  if (/^(mon|tue|wed|thu|fri|sat|sun),?\s+\d{1,2}\s+[a-z]{3,}$/i.test(value)) return -10;
  if (/^\d{1,2}\s+[a-z]{3,}\s+\d{4}$/.test(value)) return -10;

  let score = 0;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 12) score += 4;
  if (words.length > 12 && words.length <= 20) score += 1;
  if (/[a-z]/i.test(value)) score += 2;
  if (/^[a-z0-9 '&/.,()-]+$/i.test(value)) score += 1;
  if (/[0-9]{5,}/.test(value)) score -= 4;
  if (/[₹$€]/.test(value)) score -= 3;
  if (/\b(?:size|qty|quantity|colour|color|price|mrp|amount|total|order id)\b/i.test(normalized)) score -= 4;
  if (value.length >= 12 && value.length <= 90) score += 2;
  if (value.length > 120) score -= 4;
  return score;
}

function subjectSegment(subject) {
  if (!subject) {
    return "";
  }

  const segments = subject.split(/\s[-:]\s/).map((segment) => cleanProductName(segment)).filter(Boolean);
  return segments.at(-1) ?? "";
}

function cleanUrl(value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    url.hash = "";
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "source"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isLikelyProductUrl(value, store) {
  if (!value) {
    return false;
  }

  return (
    store.productHosts.some((host) => value.includes(host)) &&
    /(\/p\/|\/product\/|sku=|styleid=|\/buy|\/[0-9]{5,}|\bajio\b)/i.test(value)
  );
}

function isLikelyImageUrl(value, store) {
  if (!value) {
    return false;
  }

  const isKnownHost =
    store.imageHosts.some((host) => value.includes(host)) &&
    /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(value);
  if (!isKnownHost) {
    return false;
  }

  const lowered = value.toLowerCase();
  // /cms/ is a universal CDN convention: CMS/editorial assets (banners,
  // vouchers, reward images) live under /cms/ while product catalog images
  // live under /medias/, /assets/, or /products/ — true across AJIO, Amazon,
  // Flipkart and virtually all large e-commerce platforms.
  const isDecorative =
    /\/cms\//i.test(lowered) ||
    /\/retaillabs\//i.test(lowered) ||
    /\/static\/img\//i.test(lowered) ||
    /\/mailer\//i.test(lowered) ||
    /icon[-_]/i.test(lowered) ||
    /logo/i.test(lowered) ||
    /banner/i.test(lowered) ||
    /contact-us/i.test(lowered) ||
    /facebook|twitter|instagram|pinterest|google-plus/i.test(lowered) ||
    /assured-quality|easy-returns|handpicked/i.test(lowered) ||
    /timelinebar|timeline|helpcenter|help-center|mailheader|delivered\.png|arriving|seal_tag|tag_|rectangle|line-\d|supercoins|insider|gifticon|reversedome/i.test(lowered);
  return !isDecorative;
}

function mergeMissing(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if ((target[key] === null || target[key] === undefined || target[key] === "") && value) {
      target[key] = value;
    }
  }
}

function extractUrls(text) {
  return text.match(/https?:\/\/[^\s)>"']+/gi) ?? [];
}

function firstMatchingUrl(values, predicate) {
  for (const value of values) {
    const cleaned = cleanUrl(value);
    if (predicate(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

function bestImageUrl(values, store) {
  const candidates = values
    .map((value) => cleanUrl(value))
    .filter((value) => isLikelyImageUrl(value, store));

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((left, right) => scoreImageUrl(right) - scoreImageUrl(left));
  return candidates[0];
}

function scoreImageUrl(value) {
  let score = 0;
  if (/\/assets\/images\//i.test(value)) score += 5;
  if (/\/medias\/sys_master\//i.test(value)) score += 5;
  if (/\/v1\/assets\/images\/\d+/i.test(value)) score += 4;
  if (/\/product\//i.test(value)) score += 3;
  if (/h_\d+|w_\d+|q_\d+/i.test(value)) score += 2;
  if (/\/static\/img\/|\/retaillabs\//i.test(value)) score -= 8;
  return score;
}

function extractSlug(productUrl) {
  try {
    const url = new URL(productUrl);
    return url.pathname.split("/").filter(Boolean).slice(-1)[0] ?? "";
  } catch {
    return "";
  }
}
