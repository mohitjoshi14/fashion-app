import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { analyzeCommerceMessage } from "../parseCommerce.js";
import {
  decodeBase64Url,
  flattenPayloadParts,
  getHeaderValue,
} from "../gmail.js";

const DEFAULT_CORPUS_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-corpus.json",
);
const DEFAULT_LABELS_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-labels.json",
);

async function main() {
  const corpusPath = process.env.GMAIL_EVAL_CORPUS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_CORPUS_PATH)
    : DEFAULT_CORPUS_PATH;
  const labelsPath = process.env.GMAIL_EVAL_LABELS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_LABELS_PATH)
    : DEFAULT_LABELS_PATH;

  const corpus = JSON.parse(await fs.readFile(corpusPath, "utf8"));
  const entries = corpus.messages.map((message) => buildTemplateEntry(message));

  const exportPayload = {
    generatedAt: new Date().toISOString(),
    corpusPath,
    entryCount: entries.length,
    entries,
  };

  await fs.mkdir(path.dirname(labelsPath), { recursive: true });
  await fs.writeFile(labelsPath, JSON.stringify(exportPayload, null, 2), "utf8");
  console.log(`Wrote label template with ${entries.length} entries to ${labelsPath}`);
}

function buildTemplateEntry(message) {
  const payload = message.payload;
  const subject = getHeaderValue(payload, "subject");
  const from = getHeaderValue(payload, "from");
  const dateHeader = getHeaderValue(payload, "date");
  const internalDate = message.internalDate ? Number(message.internalDate) : undefined;
  const { text, html } = extractMessageBodies(payload);
  const parserResult = analyzeCommerceMessage(message);

  return {
    messageId: message.id,
    threadId: message.threadId,
    date: internalDate ? new Date(internalDate).toISOString() : dateHeader || null,
    from,
    subject,
    snippet: message.snippet ?? "",
    textPreview: buildPreview(text || stripHtml(html)),
    suggestions: {
      predictedTransactionalOrder: Boolean(parserResult.parsed),
      rejectionReason: parserResult.debug.rejectionReason,
      predictedStore: parserResult.debug.store,
      predictedItems: (parserResult.parsed?.items ?? []).map((item) => ({
        name: item.name,
        productUrl: item.productUrl,
        imageUrl: item.imageUrl,
      })),
    },
    gold: {
      isTransactionalOrder: null,
      expectedItemCount: null,
      expectedItems: [],
      notes: "",
    },
  };
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

function stripHtml(value) {
  return (value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPreview(value) {
  if (!value) {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, 400);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
