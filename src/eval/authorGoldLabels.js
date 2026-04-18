import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_LABELS_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-labels.json",
);

const NON_TRANSACTIONAL_SUBJECTS = new Set([
  "Hello! We'd Love To Pick Your Brain",
  "You just won rewards on your purchase!",
]);

async function main() {
  const labelsPath = process.env.GMAIL_EVAL_LABELS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_LABELS_PATH)
    : DEFAULT_LABELS_PATH;

  const labels = JSON.parse(await fs.readFile(labelsPath, "utf8"));
  const entries = labels.entries.map((entry) => authorGoldLabel(entry));

  const exportPayload = {
    ...labels,
    generatedAt: new Date().toISOString(),
    entries,
  };

  await fs.writeFile(labelsPath, JSON.stringify(exportPayload, null, 2), "utf8");
  console.log(`Authored gold labels for ${entries.length} messages in ${labelsPath}`);
}

function authorGoldLabel(entry) {
  const isTransactionalOrder = !NON_TRANSACTIONAL_SUBJECTS.has(entry.subject);
  const expectedItems = [];
  const notes = [];

  if (!isTransactionalOrder) {
    if (entry.subject === "You just won rewards on your purchase!") {
      notes.push("Post-purchase promotional rewards email; not an order lifecycle mail.");
    } else {
      notes.push("Non-order research / marketing email.");
    }

    return {
      ...entry,
      gold: {
        isTransactionalOrder: false,
        expectedItemCount: 0,
        expectedItems,
        notes: notes.join(" "),
      },
    };
  }

  const cleanedSuggestedItems = cleanSuggestedItems(entry);
  const subjectItems = extractSubjectItems(entry.subject);
  const previewItems = extractPreviewItems(entry.textPreview);

  for (const item of [...subjectItems, ...previewItems, ...cleanedSuggestedItems]) {
    pushUniqueItem(expectedItems, item);
  }

  let expectedItemCount = inferExpectedItemCount(entry, expectedItems);
  if (expectedItemCount === null && expectedItems.length > 0) {
    expectedItemCount = expectedItems.length;
  }

  if (entry.subject.includes("and 1 more item(s)")) {
    notes.push("Count inferred from subject suffix 'and 1 more item(s)'.");
  }
  if (
    entry.subject === "Your Myntra return request accepted" &&
    expectedItemCount === null &&
    expectedItems.length === 0
  ) {
    notes.push("Transactional return workflow email, but visible preview did not expose a confident product name/count.");
  }
  if (expectedItems.length < cleanedSuggestedItems.length) {
    notes.push("Dropped parser-suggested non-product rows while authoring gold items.");
  }
  if (
    entry.subject.includes("Order Confirmation") ||
    entry.subject.includes("item(s)") ||
    entry.subject.includes("M-Now") ||
    entry.subject.includes("MExpress+") ||
    entry.subject.includes("M-Express")
  ) {
    notes.push("Item names taken from confident unique product-like rows only.");
  }

  return {
    ...entry,
    gold: {
      isTransactionalOrder: true,
      expectedItemCount,
      expectedItems: expectedItems.map((name) => ({ name })),
      notes: notes.join(" ").trim(),
    },
  };
}

function inferExpectedItemCount(entry, expectedItems) {
  if (!entry.gold || entry.gold.isTransactionalOrder === false) {
    return 0;
  }

  if (entry.subject.includes("and 1 more item(s)")) {
    return 2;
  }

  if (entry.subject.includes("item(s)")) {
    return expectedItems.length > 0 ? expectedItems.length : null;
  }

  if (entry.subject.includes("item is ") || entry.subject.includes("item has ")) {
    return 1;
  }

  if (/^(Order|Out For Delivery|Partial Order|Refund Initiated|Return request initiated|Exchange request initiated)/i.test(entry.subject)) {
    return subjectImpliesSingleItem(entry.subject) ? 1 : null;
  }

  if (/Order Confirmation/i.test(entry.subject)) {
    return expectedItems.length > 0 ? expectedItems.length : null;
  }

  if (/return request accepted/i.test(entry.subject)) {
    return null;
  }

  if (/return request processed/i.test(entry.subject)) {
    return expectedItems.length > 0 ? expectedItems.length : 1;
  }

  if (/exchange request confirmation/i.test(entry.subject)) {
    return expectedItems.length > 0 ? expectedItems.length : 1;
  }

  return null;
}

function subjectImpliesSingleItem(subject) {
  return !subject.includes("and 1 more item(s)");
}

function extractSubjectItems(subject) {
  const items = [];

  const dashMatch = subject.match(
    /^(?:Order Delivered|Order Shipped|Out For Delivery|Partial Order Delivered|Partial Order Shipped|Refund Initiated|Refund initiated)\s*-\s*(.+?)(?:\s+and 1 more item\(s\))?$/i,
  );
  if (dashMatch) {
    pushUniqueItem(items, dashMatch[1]);
  }

  const returnMatch = subject.match(
    /Return request initiated for your AJIO order with\s+(.+)$/i,
  );
  if (returnMatch) {
    pushUniqueItem(items, returnMatch[1]);
  }

  const exchangeMatch = subject.match(
    /Exchange request initiated for your AJIO order with\s+(.+)$/i,
  );
  if (exchangeMatch) {
    pushUniqueItem(items, exchangeMatch[1]);
  }

  const wayMatch = subject.match(
    /Success!\s+Your AJIO Item of\s+(.+?)\s+\.\.\.\s+\+\(\d+\)\s+is on its way to you!/i,
  );
  if (wayMatch) {
    pushUniqueItem(items, wayMatch[1]);
  }

  return items;
}

function extractPreviewItems(textPreview) {
  const items = [];

  const qtyMatch = textPreview.match(/Qty:\s*\d+\s+(.+?)\s+Price\s+Rs/i);
  if (qtyMatch) {
    pushUniqueItem(items, qtyMatch[1]);
  }

  const returnedMatch = textPreview.match(/RETURNED\s+(.+?)(?:\s+Price|\s+Refund Amount|\s+Refund initiated)/i);
  if (returnedMatch) {
    pushUniqueItem(items, returnedMatch[1]);
  }

  return items;
}

function cleanSuggestedItems(entry) {
  const items = [];
  for (const suggested of entry.suggestions.predictedItems) {
    const name = cleanCandidateName(suggested.name);
    if (!name) {
      continue;
    }
    if (isNonProductCandidate(name, entry.subject)) {
      continue;
    }
    pushUniqueItem(items, name);
  }
  return items;
}

function cleanCandidateName(value) {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^RETURNED\s+/i, "")
    .trim();
}

function isNonProductCandidate(name, subject) {
  const normalized = name.toLowerCase();
  const normalizedSubject = (subject ?? "").toLowerCase();

  if (!name) return true;
  if (normalized === normalizedSubject) return true;
  if (/^\w+ sharma!$/i.test(name)) return true;
  if (/^your\b/i.test(normalized)) return true;
  if (/^we'?ve\b/i.test(normalized)) return true;
  if (/^on\s+\w{3},?\s+\d{1,2}\s+\w{3}/i.test(name)) return true;
  if (/arriving today|out for delivery|order confirmation|refund|return request|share your experience/i.test(normalized)) return true;
  if (/\d+(?:\.\d+)?[km]?\s*followers?/i.test(name)) return true;
  if (/^(sit back and relax|very poor|very good)$/i.test(normalized)) return true;
  return false;
}

function pushUniqueItem(items, name) {
  const cleaned = cleanCandidateName(name)
    .replace(/\.\.\.$/, "")
    .trim();
  if (!cleaned) {
    return;
  }

  const normalized = normalizeName(cleaned);
  if (!normalized) {
    return;
  }

  if (!items.some((existing) => normalizeName(existing) === normalized)) {
    items.push(cleaned);
  }
}

function normalizeName(value) {
  return (value ?? "")
    .toLowerCase()
    .replace(/^returned\s+/i, "")
    .replace(/\.\.\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
