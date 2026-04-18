import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

import { dedupeProducts } from "./dedupe.js";
import { getAuthorizedGmailClient, getFullMessage, listMatchingMessages } from "./gmail.js";
import { analyzeCommerceMessage } from "./parseCommerce.js";
import { buildCurrentOrderQuery } from "./queries.js";

dotenv.config();

const DEFAULT_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "outputs/ecommerce-gmail-orders.json",
);

async function main() {
  const outputPath = process.env.GMAIL_ORDERS_OUTPUT_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_ORDERS_OUTPUT_PATH)
    : DEFAULT_OUTPUT_PATH;
  const maxMessages = parseOptionalInteger(process.env.GMAIL_MAX_MESSAGES);
  const query = buildSearchQuery();
  const gmail = await getAuthorizedGmailClient();
  const matchedMessages = await listMatchingMessages(gmail, {
    query,
    limit: maxMessages ?? Infinity,
  });

  const rawOrders = [];
  const debugMessages = [];
  for (const matched of matchedMessages) {
    const fullMessage = await getFullMessage(gmail, matched.id);
    const { parsed, debug } = analyzeCommerceMessage(fullMessage);
    debugMessages.push(debug);
    if (parsed) {
      rawOrders.push(parsed);
    }
  }

  const flattenedProducts = rawOrders.flatMap((order) =>
    order.items.map((item, index) => ({
      id: buildProductId(order, item, index),
      store: order.store,
      ...item,
      evidence: [
        {
          store: order.store,
          messageId: order.messageId,
          threadId: order.threadId,
          subject: order.subject,
          from: order.from,
          date: order.date,
        },
      ],
    })),
  );

  const deduped = dedupeProducts(flattenedProducts);
  const exportPayload = {
    generatedAt: new Date().toISOString(),
    queryUsed: query,
    scannedMessageCount: matchedMessages.length,
    matchedOrderMessageCount: rawOrders.length,
    productCountBeforeDedupe: flattenedProducts.length,
    dedupedProductCount: deduped.products.length,
    products: deduped.products,
    duplicateAliases: deduped.aliases,
  };

  if (isTruthy(process.env.GMAIL_DEBUG_MATCHES)) {
    exportPayload.debugMessages = debugMessages;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(exportPayload, null, 2), "utf8");

  console.log(`Scanned ${matchedMessages.length} Gmail messages.`);
  console.log(`Matched ${rawOrders.length} ecommerce order emails.`);
  console.log(`Exported ${deduped.products.length} unique products to ${outputPath}`);
  if (maxMessages) {
    console.log(`Message cap: ${maxMessages} newest matching emails.`);
  }
}

function buildSearchQuery() {
  if (process.env.GMAIL_QUERY?.trim()) {
    return process.env.GMAIL_QUERY.trim();
  }

  const timeFilter = process.env.GMAIL_TIME_FILTER?.trim();
  return buildCurrentOrderQuery({ timeFilter });
}

function parseOptionalInteger(value) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(value ?? "");
}

function buildProductId(order, item, index) {
  const seed = item.productUrl ?? item.imageUrl ?? `${order.messageId}-${index}`;
  return `${order.store}-${Buffer.from(seed).toString("base64url").slice(0, 16)}`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
