// English labels for thesaurus concepts. The search index only holds one (Dutch) title per
// concept, but the concept's JSON-LD in the object store has prefLabels in Dutch and English.
// For the portal, the English labels should go into the index (see the proposal's open questions).

import { conceptLabels } from '../api.js';

const OBJECT_STORE = 'https://objectstore.surf.nl/87435b768620494e8e911c83d1997f24:globalise-data/objects/thesaurus';
const english = new Map(); // id -> label | null
const pending = new Map(); // id -> promise
const CONCURRENCY = 8;
const TIMEOUT_MS = 4000;

function prefLabel(labels, language) {
  return (labels || []).find((label) => label['@language'] === language)?.['@value'] || null;
}

function fetchOne(id) {
  if (english.has(id)) return Promise.resolve();
  if (!pending.has(id)) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    pending.set(id, fetch(`${OBJECT_STORE}/${encodeURIComponent(id)}.json`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => english.set(id, prefLabel(data?.prefLabel, 'en')))
      .catch(() => english.set(id, null))
      .finally(() => {
        window.clearTimeout(timer);
        pending.delete(id);
      }));
  }
  return pending.get(id);
}

export async function loadEnglish(ids) {
  const queue = [...new Set(ids.filter(Boolean))].filter((id) => !english.has(id));
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) await fetchOne(queue.shift());
  });
  await Promise.all(workers);
}

export const englishLabel = (id) => english.get(id) || null;

// Like conceptLabels() in ../api.js, but English where the thesaurus has it.
export async function conceptLabelsEn(ids) {
  const [dutch] = await Promise.all([conceptLabels(ids), loadEnglish(ids)]);
  return (id) => englishLabel(id) || dutch(id);
}
