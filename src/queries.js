import { STORES } from "./stores.js";

export const DEFAULT_CORPUS_TIME_FILTER = "newer_than:365d";

const CURRENT_TRANSACTIONAL_PHRASES = [
  "order confirmed",
  "order placed",
  "order shipped",
  "order dispatched",
  "order delivered",
  "order update",
  "order summary",
  "order id",
  "order no",
  "invoice no",
  "invoice number",
  "tracking id",
  "tracking number",
  "delivery address",
  "out for delivery",
  "item delivered",
  "return pickup",
  "exchange pickup",
  "shipment details",
  "refund initiated",
  "order item is delivered",
  "order item has been shipped",
  "order item(s) are delivered",
  "order items are delivered",
  "fwd order item",
  "order confirmation",
  "exchange order item",
  "return request initiated",
  "partial order delivered",
  "partial order shipped",
  "order item is out for delivery",
  "order item(s) have been shipped",
  "exchange request initiated",
  "exchange request confirmation",
  "return request processed",
  "on its way to you",
];

const ARCHIVE_TRANSACTIONAL_TERMS = [
  "order",
  "ordered",
  "shipped",
  "delivered",
  "shipment",
  "invoice",
  "dispatch",
  "\"order confirmed\"",
  "\"item delivered\"",
  "\"return pickup\"",
  "\"exchange pickup\"",
];

const STORE_QUERY_GROUP = [
  "(",
  ...STORES.flatMap((store, index) => (index === 0 ? [store.queryTerm] : ["OR", store.queryTerm])),
  ")",
];

const DOMAIN_QUERY_GROUP = [
  "(",
  "from:myntra.com",
  "OR",
  "from:ajio.com",
  "OR",
  "from:ajiomail.com",
  ")",
];

function buildSearchQuery({ timeFilter, storeGroup, orderTerms, extraFilters = [] }) {
  return [
    timeFilter,
    ...storeGroup,
    "(",
    ...orderTerms.flatMap((term, index) => (index === 0 ? [term] : ["OR", term])),
    ")",
    ...extraFilters,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildCurrentOrderQuery({ timeFilter } = {}) {
  return buildSearchQuery({
    timeFilter,
    storeGroup: STORE_QUERY_GROUP,
    orderTerms: CURRENT_TRANSACTIONAL_PHRASES.map((phrase) => `"${phrase}"`),
    extraFilters: ["-category:promotions", "-label:^smartlabel_promo", "-in:chats"],
  });
}

export function buildArchiveOrderQuery({ timeFilter } = {}) {
  return buildSearchQuery({
    timeFilter,
    storeGroup: STORE_QUERY_GROUP,
    orderTerms: ARCHIVE_TRANSACTIONAL_TERMS,
    extraFilters: ["-category:promotions", "-label:^smartlabel_promo", "-in:chats"],
  });
}

export function buildEvalCorpusQuery({ timeFilter = DEFAULT_CORPUS_TIME_FILTER } = {}) {
  return [timeFilter, ...DOMAIN_QUERY_GROUP, "-in:chats"].filter(Boolean).join(" ");
}
