// Cards on the Thesaurus tab: every label, where the concept sits in the hierarchy (broader and
// narrower, clickable), its definitions with their sources, related terms, matches in other
// vocabularies, and where it is used in documents and persons.

import { esMsearch, splitTitles } from '../api.js';
import { chipAttr, conceptUseLinks, escapeHtml, markTerms } from '../render.js';
import { broaderPaths, externalMatches, parseDefinition } from './concepts.js';

const SHOWN_DEFINITIONS = 2;
const SHOWN_NARROWER = 8;
const SHOWN_PATHS = 3;

// The concepts directly below each id, from the thesaurus paths: { id: [childId, …] }. The tree
// field holds every prefix of every path, so the prefixes that end one step below the id name
// its children.
export async function narrowerConcepts(ids) {
  if (!ids.length) return new Map();
  const responses = await esMsearch(ids.map((id) => ({
    index: 'thesaurus-objects',
    body: {
      size: 0,
      aggs: {
        facets: {
          nested: { path: 'facets' },
          aggs: { children: { terms: { field: 'facets.concept_hierarchy.tree', size: 500, include: `(.*\\|)?${id}\\|[^|]+` } } },
        },
      },
    },
  }))).catch(() => []);
  return new Map(ids.map((id, index) => {
    const buckets = responses[index]?.aggregations?.facets?.children?.buckets || [];
    return [id, [...new Set(buckets.map((bucket) => bucket.key.split('|').pop()))]];
  }));
}

// Every id a set of concept hits needs a label for.
export function conceptCardIds(hits, narrower) {
  return [...new Set(hits.flatMap((hit) => [hit._id, ...broaderPaths(hit._source, hit._id).flat(), ...(narrower.get(hit._id) || [])]))];
}

const conceptCrumb = (id, label) => `<button type="button" class="crumb" ${chipAttr({ fieldKey: 'concept', value: label, id }, 'concepts')} data-replace-query="true" title="Show this concept">${escapeHtml(label)}</button>`;

function definitionHtml(definition) {
  const cite = [
    definition.reference ? escapeHtml(definition.reference) : '',
    definition.source ? `<a href="${escapeHtml(definition.source)}" target="_blank" rel="noopener noreferrer">source</a>` : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="concept-def">
      <p>${escapeHtml(definition.text)}${definition.kind ? ` <span class="concept-def-note">GLOBALISE ${definition.kind}</span>` : ''}</p>
      ${cite ? `<p class="concept-cite">${cite}</p>` : ''}
    </div>`;
}

export function conceptCard(hit, terms, usage, labelOf, narrowerIds) {
  const source = hit._source;
  const titles = splitTitles(source.title);
  const name = labelOf(hit._id) || titles[0] || hit._id;
  const others = titles.filter((title) => title.toLowerCase() !== name.toLowerCase());

  const paths = broaderPaths(source, hit._id);
  const trails = paths.slice(0, SHOWN_PATHS).map((parts) => {
    const crumbs = parts.map((id) => [id, labelOf(id)]).filter(([, label]) => label).map(([id, label]) => conceptCrumb(id, label));
    return crumbs.length ? `<div class="archive-trail">${crumbs.join('<span class="crumb-sep">›</span>')}</div>` : '';
  }).join('');
  const morePaths = paths.length > SHOWN_PATHS ? `<p class="muted-note">Also in ${paths.length - SHOWN_PATHS} more place${paths.length - SHOWN_PATHS === 1 ? '' : 's'} in the thesaurus</p>` : '';

  const children = (narrowerIds || []).map((id) => [id, labelOf(id)]).filter(([, label]) => label).sort((a, b) => a[1].localeCompare(b[1]));
  const narrower = children.length
    ? `<p class="concept-row"><span class="concept-row-label">Narrower</span>${children.slice(0, SHOWN_NARROWER).map(([id, label]) => conceptCrumb(id, label)).join('<span class="crumb-sep">·</span>')}${children.length > SHOWN_NARROWER ? `<span class="muted-note"> and ${children.length - SHOWN_NARROWER} more</span>` : ''}</p>`
    : '';

  // English translations first; the Dutch originals follow.
  const definitions = (source.description || []).map(parseDefinition).filter((item) => item.text)
    .sort((a, b) => Number(b.translated) - Number(a.translated));
  const shown = definitions.slice(0, SHOWN_DEFINITIONS).map(definitionHtml).join('');
  const rest = definitions.slice(SHOWN_DEFINITIONS);
  const definitionBlock = definitions.length
    ? `<div class="concept-defs">${shown}${rest.length ? `<details class="concept-more"><summary>${rest.length} more definition${rest.length === 1 ? '' : 's'}</summary>${rest.map(definitionHtml).join('')}</details>` : ''}</div>`
    : '';

  // `related` holds labels, not ids, so these search the thesaurus by name.
  const related = (source.related || []).filter(Boolean);
  const relatedRow = related.length
    ? `<p class="concept-row"><span class="concept-row-label">Related</span>${related.slice(0, 8).map((label) => `<button type="button" class="crumb" ${chipAttr({ fieldKey: 'title', value: label }, 'concepts')} data-replace-query="true">${escapeHtml(label)}</button>`).join('<span class="crumb-sep">·</span>')}</p>`
    : '';

  const matches = externalMatches(source.identifier)
    .map((match) => `<a href="${escapeHtml(match.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match.name)}</a>`).join('');

  return `
    <article class="card card-entity card-concept" data-scope="concepts">
      <div class="card-body">
        <header class="card-head">
          <h2 class="card-title">${markTerms(name, terms)}</h2>
          <span class="scope-tag" data-field="concept">concept</span>
        </header>
        ${others.length ? `<p class="card-variants">Also: ${others.map((title) => markTerms(title, terms)).join(', ')}</p>` : ''}
        ${trails}${morePaths}
        ${definitionBlock}
        ${narrower}
        ${relatedRow}
        <footer class="card-actions">
          ${conceptUseLinks(usage, name, hit._id)}
          ${matches}
          <a href="${escapeHtml(source.id)}" target="_blank" rel="noopener noreferrer">Record</a>
        </footer>
      </div>
    </article>`;
}
