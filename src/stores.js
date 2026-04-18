export const STORES = [
  {
    id: "myntra",
    queryTerm: "myntra",
    senderPatterns: [/@myntra\.com>?$/i],
    mentionPatterns: [/\bmyntra\b/i],
    imageHosts: ["assets.myntassets.com", "myntra.com", "myntraimg.com"],
    productHosts: ["myntra.com", "myntrastudio.com"],
  },
  {
    id: "ajio",
    queryTerm: "ajio",
    senderPatterns: [/@ajio\.com>?$/i, /@ajiomail\.com>?$/i],
    mentionPatterns: [/\bajio\b/i],
    imageHosts: ["assets.ajio.com", "images.ajio.com", "ajio.com"],
    productHosts: ["ajio.com"],
  },
];

export function getStoreById(storeId) {
  return STORES.find((store) => store.id === storeId) ?? null;
}
