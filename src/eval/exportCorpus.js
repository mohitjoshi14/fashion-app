import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

import {
  getAuthorizedGmailClient,
  getFullMessage,
  getHeaderValue,
  listMatchingMessages,
} from "../gmail.js";
import {
  DEFAULT_CORPUS_TIME_FILTER,
  buildArchiveOrderQuery,
  buildCurrentOrderQuery,
  buildEvalCorpusQuery,
} from "../queries.js";

dotenv.config();

const DEFAULT_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-corpus.json",
);

async function main() {
  const outputPath = process.env.GMAIL_EVAL_CORPUS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_CORPUS_PATH)
    : DEFAULT_OUTPUT_PATH;
  const timeFilter = process.env.GMAIL_EVAL_TIME_FILTER?.trim() || DEFAULT_CORPUS_TIME_FILTER;

  const corpusQuery = buildEvalCorpusQuery({ timeFilter });
  const archiveQuery = buildArchiveOrderQuery({ timeFilter });
  const currentQuery = buildCurrentOrderQuery({ timeFilter });

  const gmail = await getAuthorizedGmailClient();

  const corpusMatches = await listMatchingMessages(gmail, {
    query: corpusQuery,
    limit: Infinity,
  });

  const [archiveMatches, currentMatches] = await Promise.all([
    listMatchingMessages(gmail, { query: archiveQuery, limit: Infinity }),
    listMatchingMessages(gmail, { query: currentQuery, limit: Infinity }),
  ]);

  const corpusIdSet = new Set(corpusMatches.map((message) => message.id));
  const archiveIdSet = new Set(
    archiveMatches
      .map((message) => message.id)
      .filter((messageId) => corpusIdSet.has(messageId)),
  );
  const currentIdSet = new Set(
    currentMatches
      .map((message) => message.id)
      .filter((messageId) => corpusIdSet.has(messageId)),
  );

  const messages = [];
  for (const matched of corpusMatches) {
    const fullMessage = await getFullMessage(gmail, matched.id);
    messages.push(fullMessage);
  }

  const summaries = messages.map((message) => summarizeMessage(message, {
    inArchiveQuery: archiveIdSet.has(message.id),
    inCurrentQuery: currentIdSet.has(message.id),
  }));

  const exportPayload = {
    generatedAt: new Date().toISOString(),
    timeFilter,
    corpusQuery,
    messageCount: messages.length,
    retrievalSets: {
      archiveOrderQuery: {
        query: archiveQuery,
        count: archiveIdSet.size,
        messageIds: [...archiveIdSet],
      },
      currentOrderQuery: {
        query: currentQuery,
        count: currentIdSet.size,
        messageIds: [...currentIdSet],
      },
    },
    summaries,
    messages,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(exportPayload, null, 2), "utf8");

  console.log(`Exported ${messages.length} Gmail messages to ${outputPath}`);
  console.log(`Archive query overlap: ${archiveIdSet.size}`);
  console.log(`Current query overlap: ${currentIdSet.size}`);
}

function summarizeMessage(message, { inArchiveQuery, inCurrentQuery }) {
  const payload = message.payload;
  const subject = getHeaderValue(payload, "subject");
  const from = getHeaderValue(payload, "from");
  const dateHeader = getHeaderValue(payload, "date");
  const internalDate = message.internalDate ? Number(message.internalDate) : undefined;

  return {
    messageId: message.id,
    threadId: message.threadId,
    from,
    subject,
    date: internalDate ? new Date(internalDate).toISOString() : dateHeader || null,
    snippet: message.snippet ?? "",
    inArchiveQuery,
    inCurrentQuery,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
