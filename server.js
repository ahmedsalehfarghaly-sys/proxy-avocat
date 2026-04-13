const express = require('express');
const axios = require('axios');

try { require('dotenv').config(); } catch (_) {}

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

/* =========================
 * Config
 * ========================= */

const LEGIFRANCE_BASE_URL =
  process.env.LEGIFRANCE_BASE_URL ||
  'https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app';

const JUDILIBRE_BASE_URL =
  process.env.JUDILIBRE_BASE_URL ||
  'https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0';

const PISTE_OAUTH_URL =
  process.env.PISTE_OAUTH_URL ||
  'https://sandbox-oauth.piste.gouv.fr/api/oauth/token';

const PISTE_CLIENT_ID = process.env.PISTE_CLIENT_ID || '';
const PISTE_CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET || '';

/* =========================
 * Token cache
 * ========================= */

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

async function getPisteToken() {
  const now = Date.now();

  if (tokenCache.accessToken && tokenCache.expiresAt > now + 60000) {
    return tokenCache.accessToken;
  }

  if (!PISTE_CLIENT_ID || !PISTE_CLIENT_SECRET) {
    const err = new Error('PISTE_CLIENT_ID or PISTE_CLIENT_SECRET is missing');
    err.code = 'missing_oauth_env';
    throw err;
  }

  const form = new URLSearchParams();
  form.append('grant_type', 'client_credentials');
  form.append('client_id', PISTE_CLIENT_ID);
  form.append('client_secret', PISTE_CLIENT_SECRET);

  const response = await axios({
    method: 'POST',
    url: PISTE_OAUTH_URL,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    data: form.toString(),
    timeout: 30000
  });

  const data = response.data || {};
  if (!data.access_token) {
    const err = new Error('OAuth token response missing access_token');
    err.code = 'oauth_missing_access_token';
    err.details = data;
    throw err;
  }

  const expiresIn = Number(data.expires_in || 3600);
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = now + expiresIn * 1000;

  return tokenCache.accessToken;
}

/* =========================
 * Helpers
 * ========================= */

function cleanString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function uniqWords(q) {
  const parts = cleanString(q).split(/\s+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out.join(' ');
}

function normalizeQuery(q) {
  return uniqWords(cleanString(q).replace(/\s+/g, ' '));
}

function hasAny(text, arr) {
  const t = (text || '').toLowerCase();
  return arr.some(x => t.includes(x.toLowerCase()));
}

function detectIntent(query) {
  const q = normalizeQuery(query);

  if (/\b(article|art\.?)\s+[a-z]?\d[\w.\-]*/i.test(q) || /\b[lrd]\.?\s?\d[\w.\-]*/i.test(q)) {
    return 'ARTICLE';
  }
  if (hasAny(q, ['code civil', 'code du travail', 'code de la sécurité sociale', 'code de commerce', 'code'])) {
    return 'CODE';
  }
  if (hasAny(q, ['cour de cassation', 'jurisprudence', 'pourvoi', 'cassation', 'arrêt'])) {
    return 'JURISPRUDENCE';
  }
  if (hasAny(q, ['jorf', 'journal officiel', 'décret', 'arrete', 'arrêté', 'ordonnance', 'nor'])) {
    return 'JORF_LODA';
  }
  if (hasAny(q, ['idcc', 'convention collective', 'syntec', 'métallurgie', 'metallurgie', 'kali'])) {
    return 'KALI';
  }
  return 'GENERIC';
}

function safeQuery(q) {
  return normalizeQuery(q);
}

function scoreResult(intent, r) {
  const origin = String(r.origin || r.type || r.nature || '').toUpperCase();
  let score = 0;

  if (intent === 'JURISPRUDENCE') {
    if (origin.includes('JURI')) score += 100;
    if ((r.title || '').toLowerCase().includes('cour de cassation')) score += 30;
  } else if (intent === 'ARTICLE' || intent === 'CODE') {
    if (origin.includes('LEGI')) score += 100;
    if (origin.includes('CODE')) score += 25;
  } else if (intent === 'KALI') {
    if (origin.includes('KALI') || origin.includes('ACCO')) score += 100;
  } else if (intent === 'JORF_LODA') {
    if (origin.includes('JORF') || origin.includes('LODA')) score += 100;
  }

  if (r.id) score += 5;
  if (r.extract || r.top_extract) score += 5;
  return score;
}

function rerankResults(intent, results) {
  if (!Array.isArray(results)) return [];
  return [...results].sort((a, b) => scoreResult(intent, b) - scoreResult(intent, a));
}

function compactError(scope, err) {
  const status = err.response?.status || 500;
  const data = err.response?.data || null;
  return {
    ok: false,
    status,
    error: `${scope}_upstream_error`,
    message: data?.message || err.message || `${scope} request failed`,
    details: data || err.details || null
  };
}

/* =========================
 * Upstream connectors
 * ========================= */

async function callLegifrance(path, payload = {}, method = 'POST') {
  try {
    const token = await getPisteToken();

    const config = {
      baseURL: LEGIFRANCE_BASE_URL,
      url: path,
      method: method.toUpperCase(),
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    };

    if (config.method === 'GET') {
      config.params = payload;
    } else {
      config.headers['Content-Type'] = 'application/json';
      config.data = payload;
    }

    const response = await axios(config);
    return response.data;
  } catch (err) {
    return compactError('legifrance', err);
  }
}

async function callJudilibre(path, query = {}) {
  try {
    const token = await getPisteToken();

    const response = await axios({
      baseURL: JUDILIBRE_BASE_URL,
      url: path,
      method: 'GET',
      params: query,
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    return response.data;
  } catch (err) {
    return compactError('judilibre', err);
  }
}

/* =========================
 * Health
 * ========================= */

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'proxy-avocat',
    version: 'v4.3.2-oauth-safe'
  });
});

app.get('/lf/commit', async (_req, res) => {
  const out = await callLegifrance('/misc/commitId', {}, 'GET');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/misc/commitId' });
});

app.get('/jd/healthcheck', async (_req, res) => {
  const out = await callJudilibre('/healthcheck', {});
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/healthcheck' });
});

/* =========================
 * Raw request
 * ========================= */

app.post('/raw/request', async (req, res) => {
  const { api, method = 'GET', path, payload = {}, query = {} } = req.body || {};

  if (!api || !path) {
    return res.status(400).json({
      ok: false,
      error: 'missing_api_or_path',
      message: 'api and path are required'
    });
  }

  if (api === 'legifrance') {
    const out = await callLegifrance(path, method.toUpperCase() === 'GET' ? query : payload, method);
    return res.status(out?.status || 200).json({ ok: !out?.error, ...out, api_used: 'legifrance', path_used: path });
  }

  if (api === 'judilibre') {
    if (method.toUpperCase() !== 'GET') {
      return res.status(400).json({
        ok: false,
        error: 'unsupported_method',
        message: 'Judilibre connector currently supports GET only'
      });
    }
    const out = await callJudilibre(path, query);
    return res.status(out?.status || 200).json({ ok: !out?.error, ...out, api_used: 'judilibre', path_used: path });
  }

  return res.status(400).json({
    ok: false,
    error: 'unknown_api',
    message: 'api must be "legifrance" or "judilibre"'
  });
});

/* =========================
 * Legifrance search
 * ========================= */

app.post('/lf/search-simple', async (req, res) => {
  const rawQuery = req.body?.query || req.body?.terms || '';
  const query = safeQuery(rawQuery);
  const pageNumber = req.body?.pageNumber || 1;
  const pageSize = req.body?.pageSize || 10;
  const fond = req.body?.fond || 'ALL';
  const intent = detectIntent(query);

  const payload = { query, pageNumber, pageSize, fond };
  const out = await callLegifrance('/search', payload, 'POST');
  const results = rerankResults(intent, out.results || out.results_preview || []);

  res.status(out?.status || 200).json({
    ok: !out?.error,
    returnedCount: results.length,
    totalResultNumber: out.totalResultNumber || out.total || 0,
    results,
    query_used: payload
  });
});

app.post('/lf/search-structured-safe', async (req, res) => {
  const rawQuery = req.body?.query || req.body?.terms || '';
  const query = safeQuery(rawQuery);
  const pageNumber = req.body?.pageNumber || 1;
  const pageSize = req.body?.pageSize || 10;
  const fond = req.body?.fond || 'ALL';
  const operateur = req.body?.operateur || 'ET';
  const typeRecherche = req.body?.typeRecherche || 'TOUS_LES_MOTS_DANS_UN_CHAMP';
  const typePagination = req.body?.typePagination || 'DEFAUT';
  const typeChamp = req.body?.typeChamp || 'ALL';
  const intent = detectIntent(query);

  const payload = {
    query,
    pageNumber,
    pageSize,
    fond,
    operateur,
    typeRecherche,
    typePagination,
    typeChamp
  };

  const out = await callLegifrance('/search', payload, 'POST');
  const results = rerankResults(intent, out.results || out.results_preview || []);

  res.status(out?.status || 200).json({
    ok: !out?.error,
    returnedCount: results.length,
    totalResultNumber: out.totalResultNumber || out.total || 0,
    results,
    query_used: payload
  });
});

app.post('/lf/suggest', async (req, res) => {
  const rawQuery = req.body?.query || req.body?.searchText || '';
  const query = safeQuery(rawQuery);
  const out = await callLegifrance('/suggest', { query }, 'POST');
  const results = rerankResults(detectIntent(query), out.results || []);

  res.status(out?.status || 200).json({
    ok: !out?.error,
    returnedCount: results.length,
    totalResultNumber: out.totalResultNumber || 0,
    results,
    query_used: { query }
  });
});

/* =========================
 * Article / code
 * ========================= */

app.post('/lf/article-resolve', async (req, res) => {
  const articleNumber = cleanString(req.body?.articleNumber);
  const codeTerms = cleanString(req.body?.codeTerms);
  const query = articleNumber && codeTerms
    ? `article ${articleNumber} ${codeTerms}`
    : safeQuery(req.body?.query || '');

  const out = await callLegifrance('/search', {
    query,
    pageNumber: 1,
    pageSize: 10,
    fond: 'ALL'
  }, 'POST');

  const results = rerankResults('ARTICLE', out.results || out.results_preview || []);
  const best = results[0] || null;

  res.status(out?.status || 200).json({
    ok: !out?.error,
    returnedCount: best ? 1 : 0,
    bestMatch: best,
    query
  });
});

app.post('/lf/article-fetch', async (req, res) => {
  const articleNumber = cleanString(req.body?.articleNumber);
  const codeTerms = cleanString(req.body?.codeTerms);
  const resolveQuery = `article ${articleNumber} ${codeTerms}`;

  const searchOut = await callLegifrance('/search', {
    query: resolveQuery,
    pageNumber: 1,
    pageSize: 5,
    fond: 'ALL'
  }, 'POST');

  const results = rerankResults('ARTICLE', searchOut.results || searchOut.results_preview || []);
  const best = results[0] || null;

  res.status(searchOut?.status || 200).json({
    ok: !searchOut?.error,
    mode: 'search_resolved',
    query: resolveQuery,
    article: best,
    searchSummary: {
      totalResultNumber: searchOut.totalResultNumber || 0,
      returnedCount: results.length
    }
  });
});

app.post('/lf/code-safe', async (req, res) => {
  const codeTerms = safeQuery(req.body?.codeTerms || req.body?.query || '');
  const out = await callLegifrance('/search', {
    query: codeTerms,
    pageNumber: 1,
    pageSize: req.body?.maxItems || 5,
    fond: 'ALL'
  }, 'POST');

  const results = rerankResults('CODE', out.results || out.results_preview || []);
  const code = results[0] || null;

  res.status(out?.status || 200).json({
    ok: !out?.error,
    mode: 'search_fallback',
    code,
    searchSummary: {
      totalResultNumber: out.totalResultNumber || 0,
      returnedCount: results.length
    },
    query_used: { query: codeTerms }
  });
});

app.post('/lf/code-resolve', async (req, res) => {
  const codeTerms = safeQuery(req.body?.codeTerms || req.body?.query || '');
  const out = await callLegifrance('/search', {
    query: codeTerms,
    pageNumber: 1,
    pageSize: req.body?.maxItems || 10,
    fond: 'ALL'
  }, 'POST');

  const results = rerankResults('CODE', out.results || out.results_preview || []);
  const outline = results.slice(0, req.body?.maxItems || 10);

  res.status(out?.status || 200).json({
    ok: !out?.error,
    mode: 'search_outline_filtered',
    outline
  });
});

/* =========================
 * JORF / LODA / circulaires / KALI / JURI
 * ========================= */

app.post('/lf/jorf/get', async (_req, res) => {
  const out = await callLegifrance('/consult/jorfCont', {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/consult/jorfCont' });
});

app.post('/lf/consult/jorf-cont', async (_req, res) => {
  const out = await callLegifrance('/consult/jorfCont', {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/consult/jorfCont' });
});

app.post('/lf/law-decree/get', async (req, res) => {
  const query = safeQuery(req.body?.query || '');
  const out = await callLegifrance('/search', {
    query,
    pageNumber: 1,
    pageSize: 10,
    fond: 'ALL'
  }, 'POST');

  const results = rerankResults('JORF_LODA', out.results || out.results_preview || []);
  res.status(out?.status || 200).json({
    ok: !out?.error,
    executionTime: out.executionTime,
    totalResultNumber: out.totalResultNumber || 0,
    results,
    path_used: '/search'
  });
});

app.post('/lf/circulaire/get', async (req, res) => {
  const query = safeQuery(req.body?.query || '');
  const out = await callLegifrance('/search', {
    query,
    pageNumber: 1,
    pageSize: 10,
    fond: 'ALL'
  }, 'POST');

  res.status(out?.status || 200).json({
    ok: !out?.error,
    executionTime: out.executionTime,
    totalResultNumber: out.totalResultNumber || 0,
    results: out.results || out.results_preview || [],
    path_used: '/search'
  });
});

app.post('/lf/juri/get', async (req, res) => {
  const query = safeQuery(req.body?.query || '');
  const out = await callLegifrance('/search', {
    query,
    pageNumber: 1,
    pageSize: 10,
    fond: 'ALL'
  }, 'POST');

  const results = rerankResults('JURISPRUDENCE', out.results || out.results_preview || []);
  res.status(out?.status || 200).json({
    ok: !out?.error,
    executionTime: out.executionTime,
    totalResultNumber: out.totalResultNumber || 0,
    results,
    path_used: '/search'
  });
});

app.post('/lf/list/loda', async (req, res) => {
  const out = await callLegifrance('/list/loda', req.body || {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/list/loda' });
});

app.post('/lf/list/conventions', async (req, res) => {
  const out = await callLegifrance('/list/conventions', req.body || {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/list/conventions' });
});

app.post('/lf/consult/last-n-jo', async (_req, res) => {
  const out = await callLegifrance('/consult/lastNJo', {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/consult/lastNJo' });
});

app.post('/lf/consult/get-jo-with-nor', async (req, res) => {
  const out = await callLegifrance('/consult/getJoWithNor', req.body || {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/consult/getJoWithNor' });
});

app.post('/lf/consult/kali-text', async (req, res) => {
  const out = await callLegifrance('/consult/kaliText', req.body || {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/consult/kaliText' });
});

app.post('/lf/consult/kali-cont-idcc', async (req, res) => {
  const out = await callLegifrance('/consult/kaliContIdcc', req.body || {}, 'POST');
  res.status(out?.status || 200).json({ ok: !out?.error, ...out, path_used: '/consult/kaliContIdcc' });
});

/* =========================
 * Judilibre
 * ========================= */

app.post('/jd/search', async (req, res) => {
  const query = safeQuery(req.body?.query || '');
  const operator = req.body?.operator || 'and';
  const page = req.body?.page || 0;
  const page_size = req.body?.page_size || 10;

  const out = await callJudilibre('/search', {
    query,
    operator,
    page,
    page_size
  });

  res.status(out?.status || 200).json({ ok: !out?.error, ...out });
});

app.get('/jd/decision', async (req, res) => {
  const id = cleanString(req.query?.id);
  const resolve_references = String(req.query?.resolve_references || 'false');

  const out = await callJudilibre('/decision', {
    id,
    resolve_references
  });

  res.status(out?.status || 200).json({ ok: !out?.error, ...out });
});

/* =========================
 * Start
 * ========================= */

app.get('/debug/oauth', async (_req, res) => {
  try {
    const token = await getPisteToken();
    res.json({
      ok: true,
      hasToken: Boolean(token)
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      message: e.message,
      status: e.response?.status || null,
      data: e.response?.data || null
    });
  }
});

app.listen(PORT, () => {
  console.log(`proxy-avocat listening on port ${PORT}`);
  console.log(`LEGIFRANCE_BASE_URL=${LEGIFRANCE_BASE_URL}`);
  console.log(`JUDILIBRE_BASE_URL=${JUDILIBRE_BASE_URL}`);
  console.log(`PISTE_OAUTH_URL=${PISTE_OAUTH_URL}`);
});
