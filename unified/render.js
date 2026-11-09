// Turns index records into HTML strings. Interactive elements only carry data-* attributes;
// app.js handles every click through one delegated listener.

import { ANNOTATION_GROUPS, ANNOTATION_TYPES, FIELD_BY_KEY, SCOPES } from './config.js';
import { archiveLevels, splitTitles, viewerUrl } from './api.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export const formatCount = (value) => Number(value || 0).toLocaleString('en-US');
const plural = (count, word) => `${formatCount(count)} ${word}${count === 1 ? '' : 's'}`;

const chipAttr = (chip, scope) => `data-add-chip="${escapeHtml(JSON.stringify(chip))}"${scope ? ` data-to-scope="${scope}"` : ''}`;

export function chipHtml(chip, { removable = false, index = 0 } = {}) {
  const def = FIELD_BY_KEY.get(chip.fieldKey);
  const display = chip.fieldKey === 'annotation' ? ANNOTATION_TYPES[chip.value]?.label || chip.value : chip.value;
  return `
    <span class="query-chip" data-index="${index}" data-field="${chip.fieldKey}"${chip.id ? ' data-resolved="true"' : ''}>
      <span class="field-name">${escapeHtml(def.label)}:</span>
      <span>${escapeHtml(display)}</span>
      ${removable ? `<button type="button" data-remove-chip="${index}" aria-label="Remove ${escapeHtml(def.label)} filter">×</button>` : ''}
    </span>`;
}

// --- Annotated text -----------------------------------------------------------------------

const ANNOTATED_SPAN = /\[([^\]]*)\]\(([^()\s]*)\)/g;
const KNOWN_ANNOTATION = /(^|&)(type%3A|placeId%3A|personId%3A|_hit_term=)/;

function parseAnnotation(raw) {
  const out = { types: [], placeId: null, personId: null, hit: false };
  raw.split('&').forEach((part) => {
    if (part.startsWith('_hit_term=')) {
      out.hit = true;
      return;
    }
    let value = part;
    try {
      value = decodeURIComponent(part);
    } catch (error) {
      return;
    }
    if (value.startsWith('type:')) out.types.push(value.slice(5));
    if (value.startsWith('placeId:')) out.placeId = value.slice(8);
    if (value.startsWith('personId:')) out.personId = value.slice(9);
  });
  return out;
}

// annotatedText is markdown-like: "[Amsterdam](type%3APlace&placeId%3AGLOB2_937)". The highlighter
// adds "_hit_term=" to the annotations that matched. Everything else is plain transcription.
export function annotatedToHtml(raw) {
  let html = '';
  let last = 0;
  for (const match of String(raw).matchAll(ANNOTATED_SPAN)) {
    if (!KNOWN_ANNOTATION.test(match[2])) continue; // literal brackets in the transcription
    html += escapeHtml(String(raw).slice(last, match.index));
    last = match.index + match[0].length;
    const ann = parseAnnotation(match[2]);
    const text = escapeHtml(match[1]);
    const type = (ann.placeId && 'Place') || (ann.personId && 'Person') || ann.types[0];
    if (!type) {
      html += ann.hit ? `<mark>${text}</mark>` : text;
      continue;
    }
    const group = ANNOTATION_TYPES[type]?.group || 'event';
    const data = `data-ann="${escapeHtml(type)}"${ann.placeId ? ` data-place="${escapeHtml(ann.placeId)}"` : ''}${ann.personId ? ` data-concept="${escapeHtml(ann.personId)}"` : ''}`;
    const label = ANNOTATION_TYPES[type]?.label || type;
    const inner = ann.hit ? `<mark>${text}</mark>` : text;
    html += `<span class="ann" data-group="${group}" ${data} title="${escapeHtml(label)}">${inner}</span>`;
  }
  return html + escapeHtml(String(raw).slice(last));
}

export const countHits = (raw) => (String(raw).match(/\]\([^)]*_hit_term[^)]*\)/g) || []).length;

// --- Name highlighting --------------------------------------------------------------------

export function markTerms(text, terms) {
  const safe = escapeHtml(text);
  if (!terms.length) return safe;
  const pattern = new RegExp(`(${terms.map((term) => escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return safe.replace(pattern, '<mark>$1</mark>');
}

// --- Cards --------------------------------------------------------------------------------

function dateLabel(doc) {
  const start = doc.startDate || '';
  const end = doc.endDate || '';
  if (!start && !end) return '';
  return !end || start === end ? start || end : `${start} – ${end}`;
}

function archiveTrail(doc) {
  const levels = archiveLevels(doc);
  if (!levels.length) return '';
  const crumbs = levels
    .map((level) => `<button type="button" class="crumb" ${chipAttr({ fieldKey: 'archive', value: level.label, id: level.path })}>${escapeHtml(level.label)}</button>`)
    .join('<span class="crumb-sep">›</span>');
  return `<div class="archive-trail" title="${escapeHtml(doc.archiveDescription)}">${crumbs}</div>`;
}

function matchBadge(count, isExact, id) {
  if (!count) return '';
  const label = `${count}${isExact ? '' : '+'} ${count === 1 && isExact ? 'match' : 'matches'}`;
  return `<span class="hit-badge" id="${id}">${label}</span>`;
}

export function documentCard(hit, index, cap) {
  const doc = hit._source;
  const fragments = hit.highlight?.annotatedText || [];
  const hits = fragments.reduce((sum, fragment) => sum + countHits(fragment), 0);
  const isExact = fragments.length < cap || !hits;
  const url = viewerUrl(doc);
  const types = (doc.documentTypeIdPaths || []).map((path) => path.split('|').pop());
  const snippets = fragments.length
    ? fragments.map((fragment) => `<p class="result-snippet">${annotatedToHtml(fragment)}</p>`).join('')
    : '<p class="result-snippet is-empty">No transcription available.</p>';
  const meta = [
    dateLabel(doc),
    doc.settlement && `<button type="button" class="meta-link" ${chipAttr({ fieldKey: 'settlement', value: doc.settlement, id: doc.settlement })}>${escapeHtml(doc.settlement)}</button>`,
    doc.inventoryNumber && `<button type="button" class="meta-link" ${chipAttr({ fieldKey: 'inventory', value: doc.inventoryNumber })}>Inventory ${escapeHtml(doc.inventoryNumber)}</button>`,
    doc.scanCount && plural(doc.scanCount, 'scan'),
  ].filter(Boolean);

  return `
    <article class="card card-document" data-doc-id="${escapeHtml(hit._id)}" data-index="${index}">
      <a class="card-thumb" href="${url}" target="_blank" rel="noopener noreferrer" data-thumb="${index}" aria-label="Open ${escapeHtml(doc.name)} in the viewer">
        <span class="thumb-placeholder">Scan</span>
      </a>
      <div class="card-body">
        <header class="card-head">
          <h2 class="card-title"><a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(doc.title || doc.name)}</a></h2>
          ${matchBadge(hits, isExact, `hits-${index}`)}
        </header>
        <div class="card-meta">${meta.map((part) => `<span>${part}</span>`).join('<span class="dot">·</span>')}</div>
        ${archiveTrail(doc)}
        ${types.length ? `<div class="pill-row" data-doctypes="${escapeHtml(JSON.stringify(types))}"></div>` : ''}
        <div class="result-snippets">${snippets}<button type="button" class="link-button" id="more-${index}" hidden></button></div>
        <footer class="card-actions">
          <button type="button" class="link-button" data-reader="${index}" aria-expanded="false">Read annotated text</button>
          <a href="${url}" target="_blank" rel="noopener noreferrer">Open in viewer</a>
          <span class="card-id">${escapeHtml(doc.name)}</span>
        </footer>
        <div class="reader" id="reader-${index}" hidden></div>
      </div>
    </article>`;
}

function leafIds(paths, fallback) {
  const leaves = (paths || []).map((path) => path.split('|').pop()).filter(Boolean);
  return [...new Set(leaves.length ? leaves : fallback || [])];
}

function pillGroup(label, fieldKey, ids, labelOf, limit = 8) {
  const named = ids.map((id) => ({ id, name: labelOf(id) })).filter((item) => item.name);
  if (!named.length) return '';
  const pills = named
    .slice(0, limit)
    .map((item) => `<button type="button" class="tag" data-field="${fieldKey}" ${chipAttr({ fieldKey, value: item.name, id: item.id }, 'persons')}>${escapeHtml(item.name)}</button>`)
    .join('');
  const extra = named.length > limit ? `<span class="tag-more">+${named.length - limit}</span>` : '';
  return `<div class="pill-row"><span class="pill-label">${label}</span>${pills}${extra}</div>`;
}

export function personIds(source) {
  return [
    ...leafIds(source.occupationIdPaths, source.occupations),
    ...leafIds(source.statusIdPaths, source.statuses),
    ...leafIds(source.identityIdPaths, source.identities),
  ];
}

export function personCard(hit, terms, labelOf, personName) {
  const source = hit._source;
  const titles = splitTitles(source.titles);
  const relations = (source.relations || []).map((id) => ({ id, name: personName(id) || id }));
  const chip = { fieldKey: 'person', value: titles[0] || hit._id, id: hit._id, variants: titles };
  return `
    <article class="card card-entity" data-scope="persons">
      <div class="card-body">
        <header class="card-head">
          <h2 class="card-title">${markTerms(titles[0] || hit._id, terms)}</h2>
          <span class="scope-tag" data-field="person">Person</span>
        </header>
        ${titles.length > 1 ? `<p class="card-variants">Also: ${titles.slice(1).map((title) => markTerms(title, terms)).join(', ')}</p>` : ''}
        ${pillGroup('Occupation', 'profession', leafIds(source.occupationIdPaths, source.occupations), labelOf)}
        ${pillGroup('Status', 'status', leafIds(source.statusIdPaths, source.statuses), labelOf)}
        ${pillGroup('Identity', 'identity', leafIds(source.identityIdPaths, source.identities), labelOf)}
        ${relations.length
          ? `<div class="pill-row"><span class="pill-label">Related</span>${relations
              .map((relation) => `<button type="button" class="tag" data-field="person" ${chipAttr({ fieldKey: 'record', value: relation.name, id: relation.id }, 'persons')}>${escapeHtml(relation.name)}</button>`)
              .join('')}</div>`
          : ''}
        <footer class="card-actions">
          <button type="button" class="link-button" ${chipAttr(chip, 'documents')} data-replace-query="true">Find in documents</button>
          <a href="${escapeHtml(source.id)}" target="_blank" rel="noopener noreferrer">Record</a>
          <span class="card-id">${escapeHtml(source.identifier || hit._id)}</span>
        </footer>
      </div>
    </article>`;
}

// Object indices only hold id and title today. Anything added later appears here by itself.
function extraFields(source) {
  const known = new Set(['id', 'identifier', 'type', 'title']);
  const rows = Object.entries(source).filter(([key, value]) => !known.has(key) && value !== null && value !== '' && !(Array.isArray(value) && !value.length));
  if (!rows.length) return '';
  const cell = (value) => escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value);
  return `<dl class="extra-fields">${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${Array.isArray(value) ? value.map(cell).join(', ') : cell(value)}</dd>`).join('')}</dl>`;
}

export function objectCard(hit, scope, terms, usage, labelOf) {
  const source = hit._source;
  const titles = splitTitles(source.title);
  const fieldKey = SCOPES[scope].field;
  const name = titles[0] || hit._id;
  const chip = { fieldKey, value: name, id: hit._id, variants: titles };
  const identifier = Array.isArray(source.identifier) ? source.identifier[0] : source.identifier;

  let links = `<button type="button" class="link-button" ${chipAttr(chip, 'documents')} data-replace-query="true">Find in documents</button>`;
  let trail = '';
  if (scope === 'concepts') {
    const chipFor = (key) => ({ fieldKey: key, value: name, id: hit._id });
    const uses = usage
      ? [
          [usage.role, 'role mention', 'role', 'documents'],
          [usage.profession, 'document with this profession', 'profession', 'documents'],
          [usage.documenttype, 'document of this type', 'documenttype', 'documents'],
          [usage.occupation, 'person with this occupation', 'profession', 'persons'],
          [usage.status, 'person with this status', 'status', 'persons'],
          [usage.identity, 'person with this identity', 'identity', 'persons'],
        ].filter(([count]) => count > 0)
      : [];
    links = uses.length
      ? uses
          .map(([count, unit, key, target]) => {
            const text = count === 1 ? `1 ${unit}` : `${formatCount(count)} ${unit.replace(/^person/, 'persons').replace(/^document/, 'documents').replace(/^role mention/, 'role mentions')}`;
            return `<button type="button" class="link-button" ${chipAttr(chipFor(key), target)} data-replace-query="true">${text}</button>`;
          })
          .join('')
      : '<span class="muted-note">Not used in documents or persons</span>';
    if (usage?.path) {
      const names = usage.path.split('|').map((id) => labelOf(id)).filter(Boolean);
      if (names.length > 1) trail = `<div class="archive-trail">${names.slice(0, -1).map((part) => `<span class="crumb is-static">${escapeHtml(part)}</span>`).join('<span class="crumb-sep">›</span>')}</div>`;
    }
  }

  return `
    <article class="card card-entity" data-scope="${scope}">
      <div class="card-body">
        <header class="card-head">
          <h2 class="card-title">${markTerms(name, terms)}</h2>
          <span class="scope-tag" data-field="${fieldKey}">${escapeHtml(SCOPES[scope].singular)}</span>
        </header>
        ${titles.length > 1 ? `<p class="card-variants">Also: ${titles.slice(1).map((title) => markTerms(title, terms)).join(', ')}</p>` : ''}
        ${trail}
        ${extraFields(source)}
        <footer class="card-actions">
          ${links}
          <a href="${escapeHtml(source.id)}" target="_blank" rel="noopener noreferrer">Record</a>
          <span class="card-id">${escapeHtml(identifier || hit._id)}</span>
        </footer>
      </div>
    </article>`;
}

// --- Facets -------------------------------------------------------------------------------

function facetList(title, items, fieldKey) {
  if (!items.length) return '';
  const max = Math.max(...items.map((item) => item.count), 1);
  return `
    <section class="facet">
      <h3>${title}</h3>
      <ul>
        ${items
          .map(
            (item) => `<li><button type="button" class="facet-row" ${chipAttr(item.chip)}>
              <span class="facet-bar" data-field="${fieldKey}" style="width:${Math.max(2, (item.count / max) * 100)}%"></span>
              <span class="facet-label">${escapeHtml(item.label)}</span>
              <span class="facet-count">${formatCount(item.count)}</span>
            </button></li>`
          )
          .join('')}
      </ul>
    </section>`;
}

// Decades on one axis: a single series, so the card title names it and no legend is needed.
function timeline(buckets, activeYear) {
  const decades = new Map();
  buckets.forEach((bucket) => {
    if (!bucket.doc_count) return;
    const year = Number(bucket.key_as_string.slice(0, 4));
    const decade = Math.floor(year / 10) * 10;
    decades.set(decade, (decades.get(decade) || 0) + bucket.doc_count);
  });
  if (!decades.size) return '';
  const all = [];
  const keys = [...decades.keys()];
  for (let decade = Math.min(...keys); decade <= Math.max(...keys); decade += 10) all.push(decade);
  const max = Math.max(...decades.values());
  const bars = all
    .map((decade) => {
      const count = decades.get(decade) || 0;
      const range = `${decade}-${decade + 9}`;
      const label = `${decade}s: ${plural(count, 'document')}`;
      const height = count ? Math.max(4, (count / max) * 100) : 0;
      return `<button type="button" class="tl-col${activeYear === range ? ' is-active' : ''}" ${count ? chipAttr({ fieldKey: 'year', value: range }) : 'disabled'} aria-label="${label}" data-tip="${label}"><span class="tl-bar" style="height:${height}%"></span></button>`;
    })
    .join('');
  return `
    <section class="facet">
      <h3>Documents per decade</h3>
      <div class="timeline">${bars}</div>
      <div class="tl-axis"><span>${all[0]}</span><span>${all[all.length - 1]}s</span></div>
    </section>`;
}

// A value shared by every result can't narrow anything down, so it isn't worth listing.
const conceptItems = (buckets, labelOf, fieldKey, limit, total) => {
  const seen = new Map();
  buckets.forEach((bucket) => {
    const id = bucket.key.split('|').pop();
    if (!labelOf(id) || bucket.doc_count >= total) return;
    if (!seen.has(id) || seen.get(id).count < bucket.doc_count) {
      seen.set(id, { label: labelOf(id), count: bucket.doc_count, chip: { fieldKey, value: labelOf(id), id } });
    }
  });
  return [...seen.values()].sort((a, b) => b.count - a.count).slice(0, limit);
};

export function archiveTree(nodes) {
  return `<ul>${nodes
    .map(
      (node) => `<li class="tree-node">
        <div class="tree-row">
          <button type="button" class="tree-toggle" data-tree-toggle="${escapeHtml(node.path)}" aria-expanded="false" aria-label="Show sections inside ${escapeHtml(node.label)}"${node.leaf ? ' hidden' : ''}>▸</button>
          <button type="button" class="tree-label" ${chipAttr({ fieldKey: 'archive', value: node.label, id: node.path })} title="${escapeHtml(node.label)}">${escapeHtml(node.label)}</button>
          <span class="facet-count">${formatCount(node.count)}</span>
        </div>
        <div class="tree-children" hidden></div>
      </li>`
    )
    .join('')}</ul>`;
}

export function documentFacets(aggs, labelOf, archiveNodes, activeYear, total) {
  const settlements = (aggs.settlements?.buckets || [])
    .filter((bucket) => bucket.key)
    .slice(0, 12)
    .map((bucket) => ({ label: bucket.key, count: bucket.doc_count, chip: { fieldKey: 'settlement', value: bucket.key, id: bucket.key } }));
  const docTypes = (aggs.documentTypes?.buckets || []).map((bucket) => ({ ...bucket, leaf: bucket.key.split('|').length }));
  return [
    timeline(aggs.years?.buckets || [], activeYear),
    facetList('Settlement', settlements, 'settlement'),
    facetList('Profession', conceptItems(aggs.professions?.buckets || [], labelOf, 'profession', 10, total), 'profession'),
    facetList('Document type', conceptItems(docTypes, labelOf, 'documenttype', 10, total), 'documenttype'),
    archiveNodes.length ? `<section class="facet"><h3>Archive</h3><div class="tree">${archiveTree(archiveNodes)}</div></section>` : '',
  ].join('');
}

export function personFacets(aggs, labelOf, total) {
  const items = (agg, fieldKey, limit) => conceptItems(agg?.buckets || [], labelOf, fieldKey, limit, total);
  return [
    facetList('Occupation', items(aggs.occupations, 'profession', 10), 'profession'),
    facetList('Status', items(aggs.statuses, 'status', 10), 'status'),
    facetList('Identity', items(aggs.identities, 'identity', 10), 'identity'),
  ].join('');
}

export function legendHtml() {
  return Object.entries(ANNOTATION_GROUPS)
    .map(([group, label]) => `<label class="legend-item" data-group="${group}"><input type="checkbox" checked data-legend="${group}" /><span class="legend-swatch"></span>${label}</label>`)
    .join('');
}
