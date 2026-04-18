import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const DEFAULT_PAGE_SIZE = 100;

export async function getAuthorizedGmailClient({
  credentialsPath,
  tokenPath,
} = {}) {
  const resolvedCredentialsPath =
    credentialsPath ??
    process.env.GMAIL_OAUTH_CLIENT_PATH ??
    path.resolve(process.cwd(), "config/gmail-oauth-client.json");
  const resolvedTokenPath =
    tokenPath ??
    process.env.GMAIL_OAUTH_TOKEN_PATH ??
    path.resolve(process.cwd(), "config/gmail-token.json");

  await assertFileExists(
    resolvedCredentialsPath,
    `Missing Gmail OAuth client file at ${resolvedCredentialsPath}. Download a Google OAuth desktop client JSON and update GMAIL_OAUTH_CLIENT_PATH if needed.`,
  );

  const auth = await loadSavedCredentialsIfPresent(resolvedCredentialsPath, resolvedTokenPath);
  const client =
    auth ??
    (await authenticate({
      scopes: GMAIL_SCOPES,
      keyfilePath: resolvedCredentialsPath,
    }));

  if (!auth) {
    await saveCredentials(resolvedCredentialsPath, resolvedTokenPath, client);
  }

  return google.gmail({ version: "v1", auth: client });
}

async function loadSavedCredentialsIfPresent(credentialsPath, tokenPath) {
  try {
    const tokenRaw = await fs.readFile(tokenPath, "utf8");
    const token = JSON.parse(tokenRaw);
    return google.auth.fromJSON(token);
  } catch {
    return null;
  }
}

async function assertFileExists(filePath, errorMessage) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(errorMessage);
  }
}

async function saveCredentials(credentialsPath, tokenPath, client) {
  const credentialsRaw = await fs.readFile(credentialsPath, "utf8");
  const credentials = JSON.parse(credentialsRaw);
  const key =
    credentials.installed ?? credentials.web ?? credentials;

  if (!key.client_id || !key.client_secret) {
    throw new Error(
      `OAuth client file at ${credentialsPath} is missing client_id/client_secret.`,
    );
  }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(
    tokenPath,
    JSON.stringify(
      {
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export async function listMatchingMessages(
  gmail,
  {
    query,
    maxResults = DEFAULT_PAGE_SIZE,
    limit = Infinity,
  },
) {
  const messages = [];
  let pageToken;

  while (messages.length < limit) {
    const batchSize = Math.min(maxResults, limit - messages.length, DEFAULT_PAGE_SIZE);
    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Number.isFinite(batchSize) ? batchSize : DEFAULT_PAGE_SIZE,
      pageToken,
    });

    const batch = response.data.messages ?? [];
    messages.push(...batch);

    pageToken = response.data.nextPageToken;
    if (!pageToken || batch.length === 0) {
      break;
    }
  }

  return messages.slice(0, limit);
}

export async function getFullMessage(gmail, messageId) {
  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return response.data;
}

export function decodeBase64Url(value) {
  if (!value) {
    return "";
  }

  return Buffer.from(value, "base64url").toString("utf8");
}

export function flattenPayloadParts(payload) {
  if (!payload) {
    return [];
  }

  const parts = [];
  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    parts.push(current);
    for (const child of current.parts ?? []) {
      queue.push(child);
    }
  }

  return parts;
}

export function getHeaderValue(payload, name) {
  const header = (payload?.headers ?? []).find(
    (entry) => entry.name?.toLowerCase() === name.toLowerCase(),
  );
  return header?.value ?? "";
}
