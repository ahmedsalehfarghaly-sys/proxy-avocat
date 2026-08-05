'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const baseUrl = process.env.INTEGRATION_BASE_URL;

function skippedReason() {
  if (!baseUrl) return 'INTEGRATION_BASE_URL non défini';
  return null;
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl.replace(/\/$/, '') + path, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test('smoke /health', { skip: skippedReason() }, async () => {
  const { response, body } = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test('article strict: article 9 du code de procédure civile', { skip: skippedReason() }, async () => {
  const { response, body } = await request('/lf/article-fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ articleNumber: '9', codeTerms: 'code de procédure civile' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test('Judilibre rejette une période inversée', { skip: skippedReason() }, async () => {
  const { response, body } = await request('/jd/search?query=responsabilite&date_start=2024-12-31&date_end=2024-01-01');
  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
});
