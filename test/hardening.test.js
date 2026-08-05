'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const hardening = require('../hardening');

test('selectStrictArticle respecte le numéro et le code demandés', () => {
  const result = hardening.selectStrictArticle([
    { numero: '1240', titreTexte: 'Code de procédure civile', id: 'bad-code' },
    { numero: '1241', titreTexte: 'Code civil', id: 'bad-number' },
    { numero: '1240', titreTexte: 'Code civil', id: 'good' }
  ], '1240', 'Code civil');
  assert.equal(result.id, 'good');
});

test('parseArticleQuery extrait article et code', () => {
  assert.deepEqual(hardening.parseArticleQuery('article L. 622-7 du code de commerce'), {
    articleNumber: 'L.622-7',
    codeTerms: 'code de commerce'
  });
});

test('buildQueryString répète les paramètres multiples', () => {
  const query = hardening.buildQueryString({ keys: 'year,solution', chamber: ['civ1', 'civ2'] });
  const params = new URLSearchParams(query);
  assert.deepEqual(params.getAll('keys'), ['year', 'solution']);
  assert.deepEqual(params.getAll('chamber'), ['civ1', 'civ2']);
});

test('validateDateRange contrôle format et ordre', () => {
  assert.equal(hardening.validateDateRange('2022-01-01', '2022-12-31'), null);
  assert.match(hardening.validateDateRange('2022-13-01', '2022-12-31'), /format/);
  assert.match(hardening.validateDateRange('2023-01-01', '2022-12-31'), /antérieure/);
});

test('filterJudilibreResults filtre période, chambre et solution', () => {
  const result = hardening.filterJudilibreResults({ results: [
    { id: '1', chamber: 'civ2', solution: 'Rejet', decision_date: '2022-03-01' },
    { id: '2', chamber: 'civ1', solution: 'Rejet', decision_date: '2022-03-01' },
    { id: '3', chamber: 'civ2', solution: 'Cassation', decision_date: '2022-03-01' },
    { id: '4', chamber: 'civ2', solution: 'Rejet', decision_date: '2021-12-31' }
  ] }, { chamber: 'civ2', solution: 'Rejet', date_start: '2022-01-01', date_end: '2022-12-31' });
  assert.deepEqual(result.results.map(item => item.id), ['1']);
  assert.equal(result.filterValidation.filteredOut, 3);
  assert.equal(result.filterValidation.dateField, 'decision_date');
});

test('makeCompactPayload élimine les champs lourds', () => {
  const payload = { ok: true, result: { id: 'X', liens: Array.from({ length: 100 }, (_, index) => ({ index })), texte: 'x'.repeat(100000) } };
  const compacted = hardening.makeCompactPayload(payload, { includeText: false, maxBytes: 20000 });
  assert.equal(compacted.result.liens, undefined);
  assert.equal(compacted.result.texte, undefined);
  assert.equal(compacted.meta.compacted, true);
});

test('selectApplicableVersion sélectionne la version à la date des faits', () => {
  const selected = hardening.selectApplicableVersion({ versions: [
    { id: 'old', dateStart: '2010-01-01', dateEnd: '2019-12-31' },
    { id: 'new', dateStart: '2020-01-01', dateEnd: null }
  ] }, '2021-06-01');
  assert.equal(selected.id, 'new');
});
