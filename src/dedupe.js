function normalizeText(value) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return new Set(normalizeText(value).split(/\s+/).filter(Boolean));
}

function jaccardSimilarity(left, right) {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function normalizedProductIdentity(item) {
  const url = item.productUrl ? normalizeProductUrl(item.productUrl) : "";
  const image = item.imageUrl ? normalizeAssetUrl(item.imageUrl) : "";
  const name = normalizeText(item.name);
  const brand = normalizeText(item.brand);
  const price = item.price ?? "";
  return { url, image, name, brand, price };
}

function normalizeProductUrl(url) {
  try {
    const parsed = new URL(url);
    const styleId =
      parsed.searchParams.get("styleid") ??
      parsed.searchParams.get("sku") ??
      parsed.pathname.match(/(\d{5,})/)?.[1];
    return styleId ? `style:${styleId}` : parsed.origin + parsed.pathname.toLowerCase();
  } catch {
    return normalizeText(url);
  }
}

function normalizeAssetUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.origin + parsed.pathname).toLowerCase();
  } catch {
    return normalizeText(url);
  }
}

export function dedupeProducts(products) {
  const canonical = [];
  const aliases = [];

  for (const product of products) {
    const identity = normalizedProductIdentity(product);
    const existing = canonical.find((candidate) => isSameProduct(identity, normalizedProductIdentity(candidate)));

    if (!existing) {
      canonical.push({
        ...product,
        evidence: [...(product.evidence ?? [])],
      });
      continue;
    }

    aliases.push({
      droppedProduct: product,
      keptProductId: existing.id,
    });

    mergeProduct(existing, product);
  }

  return { products: canonical, aliases };
}

function isSameProduct(left, right) {
  if (left.url && right.url && left.url === right.url) {
    return true;
  }

  if (left.image && right.image && left.image === right.image) {
    return true;
  }

  if (left.brand && right.brand && left.brand === right.brand && left.price && right.price && left.price === right.price) {
    return jaccardSimilarity(left.name, right.name) >= 0.5;
  }

  return jaccardSimilarity(`${left.brand} ${left.name}`, `${right.brand} ${right.name}`) >= 0.82;
}

function mergeProduct(target, source) {
  for (const key of ["name", "brand", "productUrl", "imageUrl"]) {
    if (!target[key] && source[key]) {
      target[key] = source[key];
    }
  }

  if (!target.price && source.price) {
    target.price = source.price;
  }

  const seen = new Set((target.evidence ?? []).map((entry) => entry.messageId));
  for (const entry of source.evidence ?? []) {
    if (!seen.has(entry.messageId)) {
      target.evidence.push(entry);
      seen.add(entry.messageId);
    }
  }
}
