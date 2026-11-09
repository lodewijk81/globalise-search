// Everything that describes the indices lives here: what can be searched, and how the
// filter pills map onto each index. query.js and api.js read these tables and hold no
// index-specific knowledge of their own.

export const ES_BASE = 'https://search.globalise.nl';

// One "scope" per index. These are the tabs above the results.
export const SCOPES = {
  documents: { index: 'documents', label: 'Documents', singular: 'document', field: 'documents' },
  persons: { index: 'persons', label: 'Persons', singular: 'person', field: 'person' },
  places: { index: 'place-objects', label: 'Places', singular: 'place', field: 'place' },
  organisations: { index: 'organisation-objects', label: 'Organisations', singular: 'organisation', field: 'organisation' },
  polities: { index: 'polity-objects', label: 'Polities', singular: 'polity', field: 'polity' },
  ships: { index: 'ship-objects', label: 'Ships', singular: 'ship', field: 'ship' },
  concepts: { index: 'thesaurus-objects', label: 'Thesaurus', singular: 'concept', noun: 'concepts', field: 'concept' },
};

export const SCOPE_KEYS = Object.keys(SCOPES);

// The filter pills. `scopes` lists the indices a pill can filter; a scope that isn't listed is
// shown as unavailable while that pill is active. `scored` pills go in the relevance part of
// the query (documents mentioning Batavia most often rank first); the rest are plain filters.
export const FIELD_DEFS = [
  { key: 'place', label: 'Place', hint: 'A place tagged in the text, e.g. Batavia', aliases: ['location', 'plaats'], scopes: ['documents', 'places'], scored: true, source: 'place' },
  { key: 'person', label: 'Person', hint: 'A named person, every recorded spelling', aliases: ['name', 'personname', 'persoon'], scopes: ['documents', 'persons'], scored: true, source: 'person' },
  { key: 'ship', label: 'Ship', hint: 'A ship, by any of its recorded names', aliases: ['schip'], scopes: ['documents', 'ships'], scored: true, source: 'ship' },
  { key: 'organisation', label: 'Organisation', hint: 'e.g. Danish East India Company', aliases: ['organization', 'org', 'group'], scopes: ['documents', 'organisations'], scored: true, source: 'organisation' },
  { key: 'polity', label: 'Polity', hint: 'e.g. Mataram', aliases: ['rijk'], scopes: ['documents', 'polities'], scored: true, source: 'polity' },
  { key: 'role', label: 'Role mention', hint: 'A role tagged at that spot in the text, e.g. koopman', aliases: ['mention', 'rol'], scopes: ['documents'], scored: true, source: 'concept', countAs: 'role' },
  { key: 'profession', label: 'Profession', hint: 'A profession or a whole group of them', aliases: ['occupation', 'beroep'], scopes: ['documents', 'persons'], source: 'concept', countAs: 'profession' },
  { key: 'status', label: 'Status', hint: 'Status of a person, e.g. vrij persoon', aliases: [], scopes: ['persons'], source: 'concept', countAs: 'status' },
  { key: 'identity', label: 'Identity', hint: 'Identity of a person, e.g. Chinees', aliases: ['ethnicity'], scopes: ['persons'], source: 'concept', countAs: 'identity' },
  { key: 'concept', label: 'Thesaurus', hint: 'Any thesaurus concept, wherever it is used', aliases: ['thesaurus'], scopes: ['documents', 'persons', 'concepts'], source: 'concept', countAs: 'concept' },
  { key: 'annotation', label: 'Annotation', hint: 'Event or entity tag, e.g. Payment, Voyage', aliases: ['ann', 'type', 'event', 'tag'], scopes: ['documents'], scored: true, source: 'annotation' },
  { key: 'documenttype', label: 'Document type', hint: 'e.g. brief, resolutie', aliases: ['doctype'], scopes: ['documents'], source: 'concept', countAs: 'documenttype' },
  { key: 'title', label: 'Title', hint: 'Words in the title or name of a record', aliases: ['titel'], scopes: ['documents', 'persons', 'places', 'organisations', 'polities', 'ships', 'concepts'] },
  { key: 'settlement', label: 'Settlement', hint: 'e.g. Batavia, Goede Hoop', aliases: [], scopes: ['documents'], source: 'settlement' },
  { key: 'archive', label: 'Archive', hint: 'A series or section of the archive', aliases: ['ead', 'series'], scopes: ['documents'], source: 'archive' },
  { key: 'inventory', label: 'Inventory', hint: 'Inventory number, or e.g. 11*', aliases: ['inv', 'invnr'], scopes: ['documents'], source: 'inventory' },
  { key: 'year', label: 'Year', hint: 'e.g. 1685 or 1680-1690', aliases: ['date', 'jaar'], scopes: ['documents'] },
  // Only ever set by clicking a related person on a person card, so it isn't offered in the box.
  { key: 'record', label: 'Person record', hint: '', aliases: [], scopes: ['persons'], hidden: true },
];

export const FIELD_BY_KEY = new Map(FIELD_DEFS.map((def) => [def.key, def]));
export const FIELD_ALIASES = new Map();
FIELD_DEFS.forEach((def) => {
  FIELD_ALIASES.set(def.key, def.key);
  def.aliases.forEach((alias) => FIELD_ALIASES.set(alias, def.key));
});

// Every value seen in the `type:` annotation of annotatedText. `group` picks the colour family
// used for the annotation in result snippets and in the reader.
export const ANNOTATION_TYPES = {
  Person: { label: 'Person', group: 'person' },
  Place: { label: 'Place', group: 'place' },
  Group: { label: 'Group', group: 'group' },
  HumanMadeObject: { label: 'Ship or object', group: 'object' },
  PersistentItem: { label: 'Persistent item', group: 'object' },
  Dimension: { label: 'Quantity', group: 'dimension' },
  TimeSpan: { label: 'Date', group: 'time' },
  Voyage: { label: 'Voyage', group: 'event' },
  Move: { label: 'Move', group: 'event' },
  CorrespondenceEvent: { label: 'Correspondence', group: 'event' },
  Payment: { label: 'Payment', group: 'event' },
  Purchase: { label: 'Purchase', group: 'event' },
  Acquisition: { label: 'Acquisition', group: 'event' },
  DeclarativeAcquisition: { label: 'Declared acquisition', group: 'event' },
  DeclarativeJoining: { label: 'Declared joining', group: 'event' },
  DeclarativeLeaving: { label: 'Declared leaving', group: 'event' },
  Production: { label: 'Production', group: 'event' },
  Transformation: { label: 'Transformation', group: 'event' },
  Attack: { label: 'Attack', group: 'event' },
  Destruction: { label: 'Destruction', group: 'event' },
  IntentionalDestruction: { label: 'Intentional destruction', group: 'event' },
  DestructivePhysicalModification: { label: 'Destructive modification', group: 'event' },
  ExerciseOfAuthority: { label: 'Exercise of authority', group: 'event' },
  ActOfAuthority: { label: 'Act of authority', group: 'event' },
  SpeechAct: { label: 'Speech act', group: 'event' },
  SymbolicAct: { label: 'Symbolic act', group: 'event' },
  PromissoryAgreement: { label: 'Promissory agreement', group: 'event' },
  Event: { label: 'Other event', group: 'event' },
  InternalChange: { label: 'Internal change', group: 'state' },
  InternalState: { label: 'Internal state', group: 'state' },
  PhysicalLocativeStatus: { label: 'Physical location', group: 'state' },
  SocialRelationStatus: { label: 'Social relation', group: 'state' },
  OwnershipStatus: { label: 'Ownership', group: 'state' },
  ObligationStatus: { label: 'Obligation', group: 'state' },
  PromissoryStatus: { label: 'Promise', group: 'state' },
};

export const ANNOTATION_GROUPS = {
  person: 'Persons',
  place: 'Places',
  group: 'Groups',
  object: 'Ships and objects',
  dimension: 'Quantities',
  time: 'Dates',
  event: 'Events',
  state: 'States',
};

export const PAGE_SIZE = 10;
export const FRAGMENT_CAP = 3;
// Elasticsearch refuses from + size beyond this.
export const MAX_RESULT_WINDOW = 10000;

export const SORTS = {
  documents: [
    { key: 'relevance', label: 'Relevance' },
    { key: 'date-asc', label: 'Oldest first', sort: [{ startDate: 'asc' }] },
    { key: 'date-desc', label: 'Newest first', sort: [{ endDate: 'desc' }] },
    { key: 'scans-desc', label: 'Most scans first', sort: [{ scanCount: 'desc' }] },
    // inventoryNumber is a keyword and script sorts are blocked, so this is text order.
    { key: 'inventory', label: 'Inventory (text order)', sort: [{ inventoryNumber: 'asc' }] },
  ],
  persons: [
    { key: 'relevance', label: 'Relevance' },
    { key: 'name-asc', label: 'Name A–Z', sort: [{ titles: 'asc' }] },
  ],
};
