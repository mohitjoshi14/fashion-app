# Myntra Gmail Extractor

This `src/` folder is a standalone Node.js utility that:

- connects to Gmail using OAuth
- scans Myntra order-related emails, with an optional time filter
- extracts purchased product URLs, product images, price, brand, and product names when present
- deduplicates similar products across repeated order/shipping/delivery emails
- writes the result to JSON at `outputs/myntra-gmail-orders.json`

## Setup

1. Install Node.js dependencies:

```bash
npm install
```

2. In Google Cloud Console, create an OAuth client for a desktop app and enable the Gmail API.

3. Download the OAuth client JSON and place it at `config/gmail-oauth-client.json` or update `GMAIL_OAUTH_CLIENT_PATH` in `.env`.

## Run

```bash
npm run extract:myntra-orders
```

On the first run, a browser window opens for Gmail OAuth consent. The refresh token is then cached in `config/gmail-token.json`.

To limit the scan window, set `GMAIL_TIME_FILTER` in `.env`. Examples:

```bash
GMAIL_TIME_FILTER=newer_than:365d
GMAIL_TIME_FILTER=after:2025/01/01
```

If `GMAIL_TIME_FILTER` is empty or unset, the extractor searches without a date restriction. If you set `GMAIL_QUERY`, that full Gmail query is used as-is.

To keep scans fast while testing, set `GMAIL_MAX_MESSAGES` in `.env`, for example:

```bash
GMAIL_MAX_MESSAGES=100
```

The extractor now defaults to a stricter transactional Myntra query and rejects common marketing-style subjects during parsing.

## Output shape

The exporter writes a JSON file containing:

- scan metadata
- the Gmail query used
- unique deduped products
- duplicate alias records showing which raw items were collapsed

Each product record may include `name`, `brand`, `price`, `currency`, `productUrl`, `imageUrl`, and `evidence` pointing back to the source Gmail message metadata.
