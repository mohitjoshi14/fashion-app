import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { analyzeCommerceMessage } from "../parseCommerce.js";

const DEFAULT_CORPUS_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-corpus.json",
);
const DEFAULT_LABELS_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-labels.json",
);
const DEFAULT_RESULTS_PATH = path.resolve(
  process.cwd(),
  "outputs/eval/gmail-last365-results.json",
);

async function main() {
  const corpusPath = process.env.GMAIL_EVAL_CORPUS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_CORPUS_PATH)
    : DEFAULT_CORPUS_PATH;
  const labelsPath = process.env.GMAIL_EVAL_LABELS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_LABELS_PATH)
    : DEFAULT_LABELS_PATH;
  const resultsPath = process.env.GMAIL_EVAL_RESULTS_PATH
    ? path.resolve(process.cwd(), process.env.GMAIL_EVAL_RESULTS_PATH)
    : DEFAULT_RESULTS_PATH;

  const corpus = JSON.parse(await fs.readFile(corpusPath, "utf8"));
  const labels = JSON.parse(await fs.readFile(labelsPath, "utf8"));

  const labelById = new Map(labels.entries.map((entry) => [entry.messageId, entry]));
  const parserPredictions = corpus.messages.map((message) => {
    const result = analyzeCommerceMessage(message);
    return {
      messageId: message.id,
      parsed: result.parsed,
      debug: result.debug,
    };
  });

  const emailEval = evaluateEmailClassification(parserPredictions, labelById);
  const retrievalEvals = {
    archiveOrderQuery: evaluateRetrieval(
      corpus.retrievalSets.archiveOrderQuery.messageIds,
      labelById,
    ),
    currentOrderQuery: evaluateRetrieval(
      corpus.retrievalSets.currentOrderQuery.messageIds,
      labelById,
    ),
  };
  const itemEval = evaluateItemExtraction(parserPredictions, labelById);

  const exportPayload = {
    generatedAt: new Date().toISOString(),
    corpusPath,
    labelsPath,
    corpusMessageCount: corpus.messages.length,
    labeledMessageCount: labels.entries.length,
    retrievalEvals,
    emailClassificationEval: emailEval,
    itemExtractionEval: itemEval,
  };

  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(exportPayload, null, 2), "utf8");

  printSummary(exportPayload);
  console.log(`\nSaved detailed results to ${resultsPath}`);
}

function evaluateEmailClassification(predictions, labelById) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const mismatches = [];

  for (const prediction of predictions) {
    const label = labelById.get(prediction.messageId);
    if (!label || typeof label.gold.isTransactionalOrder !== "boolean") {
      continue;
    }

    const predicted = Boolean(prediction.parsed);
    const actual = label.gold.isTransactionalOrder;

    if (predicted && actual) tp += 1;
    else if (predicted && !actual) fp += 1;
    else if (!predicted && actual) fn += 1;
    else tn += 1;

    if (predicted !== actual) {
      mismatches.push({
        messageId: prediction.messageId,
        subject: label.subject,
        from: label.from,
        expectedTransactionalOrder: actual,
        predictedTransactionalOrder: predicted,
        rejectionReason: prediction.debug.rejectionReason,
        predictedItems: (prediction.parsed?.items ?? []).map((item) => item.name),
        notes: label.gold.notes,
      });
    }
  }

  return {
    confusionMatrix: { tp, fp, fn, tn },
    metrics: buildMetrics({ tp, fp, fn }),
    mismatches,
  };
}

function evaluateRetrieval(messageIds, labelById) {
  const idSet = new Set(messageIds);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const falsePositives = [];
  const falseNegatives = [];

  for (const label of labelById.values()) {
    if (typeof label.gold.isTransactionalOrder !== "boolean") {
      continue;
    }

    const retrieved = idSet.has(label.messageId);
    const actual = label.gold.isTransactionalOrder;

    if (retrieved && actual) tp += 1;
    else if (retrieved && !actual) {
      fp += 1;
      falsePositives.push({
        messageId: label.messageId,
        subject: label.subject,
        from: label.from,
        notes: label.gold.notes,
      });
    } else if (!retrieved && actual) {
      fn += 1;
      falseNegatives.push({
        messageId: label.messageId,
        subject: label.subject,
        from: label.from,
        notes: label.gold.notes,
      });
    } else {
      tn += 1;
    }
  }

  return {
    confusionMatrix: { tp, fp, fn, tn },
    metrics: buildMetrics({ tp, fp, fn }),
    falsePositives,
    falseNegatives,
  };
}

function evaluateItemExtraction(predictions, labelById) {
  let exactCountMatches = 0;
  let countLabeledMessages = 0;
  let labeledTransactionalMessages = 0;
  let totalGoldItems = 0;
  let totalPredictedItems = 0;
  let matchedItems = 0;
  const mismatches = [];

  for (const prediction of predictions) {
    const label = labelById.get(prediction.messageId);
    if (!label?.gold.isTransactionalOrder) {
      continue;
    }

    labeledTransactionalMessages += 1;

    const expectedItemCount = Number.isInteger(label.gold.expectedItemCount)
      ? label.gold.expectedItemCount
      : null;
    const goldNames = label.gold.expectedItems.map((item) => normalizeName(item.name));
    const predictedNames = (prediction.parsed?.items ?? []).map((item) => normalizeName(item.name));

    totalGoldItems += goldNames.length;
    totalPredictedItems += predictedNames.length;

    if (expectedItemCount !== null) {
      countLabeledMessages += 1;
      if (expectedItemCount === predictedNames.length) {
        exactCountMatches += 1;
      }
    } else if (goldNames.length === predictedNames.length) {
      exactCountMatches += 1;
    }

    const remainingGold = [...goldNames];
    let messageMatches = 0;
    for (const predictedName of predictedNames) {
      const index = remainingGold.indexOf(predictedName);
      if (index >= 0) {
        remainingGold.splice(index, 1);
        matchedItems += 1;
        messageMatches += 1;
      }
    }

    if (messageMatches !== goldNames.length || predictedNames.length !== goldNames.length) {
      mismatches.push({
        messageId: prediction.messageId,
        subject: label.subject,
        from: label.from,
        expectedItemCount,
        expectedItems: label.gold.expectedItems,
        predictedItems: (prediction.parsed?.items ?? []).map((item) => ({
          name: item.name,
          imageUrl: item.imageUrl,
          productUrl: item.productUrl,
        })),
        rejectionReason: prediction.debug.rejectionReason,
        notes: label.gold.notes,
      });
    }
  }

  const precision = totalPredictedItems === 0 ? 0 : matchedItems / totalPredictedItems;
  const recall = totalGoldItems === 0 ? 0 : matchedItems / totalGoldItems;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    labeledTransactionalMessages,
    countLabeledMessages,
    exactCountAccuracy:
      countLabeledMessages === 0 ? 0 : exactCountMatches / countLabeledMessages,
    totalGoldItems,
    totalPredictedItems,
    matchedItems,
    metrics: { precision, recall, f1 },
    mismatches,
  };
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

function buildMetrics({ tp, fp, fn }) {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function printSummary(results) {
  console.log("=== Retrieval evals ===");
  for (const [name, evaluation] of Object.entries(results.retrievalEvals)) {
    console.log(
      `${name}: precision=${formatPct(evaluation.metrics.precision)}, recall=${formatPct(evaluation.metrics.recall)}, f1=${formatPct(evaluation.metrics.f1)}`,
    );
  }

  console.log("\n=== Email classification ===");
  console.log(
    `precision=${formatPct(results.emailClassificationEval.metrics.precision)}, recall=${formatPct(results.emailClassificationEval.metrics.recall)}, f1=${formatPct(results.emailClassificationEval.metrics.f1)}`,
  );
  console.log(`mismatches=${results.emailClassificationEval.mismatches.length}`);

  console.log("\n=== Item extraction ===");
  console.log(`labeledTransactionalMessages=${results.itemExtractionEval.labeledTransactionalMessages}`);
  console.log(`exactCountAccuracy=${formatPct(results.itemExtractionEval.exactCountAccuracy)}`);
  console.log(
    `name precision=${formatPct(results.itemExtractionEval.metrics.precision)}, recall=${formatPct(results.itemExtractionEval.metrics.recall)}, f1=${formatPct(results.itemExtractionEval.metrics.f1)}`,
  );
  console.log(`item mismatches=${results.itemExtractionEval.mismatches.length}`);
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
