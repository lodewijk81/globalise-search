// Prototype-only adjustments to the shared tables in ../config.js. Imported first by app.js.

import { FIELD_ALIASES, FIELD_BY_KEY, SCOPES, SCOPE_KEYS } from '../config.js';

// Polities are a kind of organisation: one tab and one search field for both. They are still
// two indexes, so the Organisations tab searches both at once.
SCOPES.organisations.index = 'organisation-objects,polity-objects';
const polities = SCOPE_KEYS.indexOf('polities');
if (polities !== -1) SCOPE_KEYS.splice(polities, 1);
['polity', 'polities'].forEach((alias) => FIELD_ALIASES.set(alias, 'organisation'));

// No Dutch aliases: one name per field keeps the syntax, the suggestions and the help simple.
const DUTCH = ['plaats', 'persoon', 'schip', 'rijk', 'rol', 'beroep', 'titel', 'jaar'];
FIELD_BY_KEY.forEach((def) => {
  def.aliases = def.aliases.filter((alias) => !DUTCH.includes(alias));
});
DUTCH.forEach((alias) => FIELD_ALIASES.delete(alias));
FIELD_BY_KEY.get('polity').hidden = true;
FIELD_BY_KEY.get('organisation').hint = 'An organisation or polity, e.g. Danish East India Company, Mataram';

// Clearer names for the person properties.
FIELD_BY_KEY.get('profession').label = 'Occupation';
FIELD_BY_KEY.get('identity').label = 'Ethno-religious appellation';
FIELD_BY_KEY.get('role').label = 'Role in the text';
FIELD_BY_KEY.get('documenttype').label = 'Document type';

// Specific statuses and identities are tagged in the texts too (personId:<concept>), so these
// fields also search documents, like occupations do.
['status', 'identity'].forEach((key) => {
  const def = FIELD_BY_KEY.get(key);
  if (!def.scopes.includes('documents')) def.scopes.unshift('documents');
});
