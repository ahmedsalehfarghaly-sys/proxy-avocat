/**
 * proxy-avocat v4.3.2  –  complet
 *
 * Prérequis : Node 18+  (fetch natif)
 *
 * Variables d'environnement :
 *   LF_CLIENT_ID       – client_id PISTE pour Légifrance
 *   LF_CLIENT_SECRET   – client_secret PISTE pour Légifrance
 *   JD_CLIENT_ID       – client_id PISTE pour Judilibre  (fallback: LF_CLIENT_ID)
 *   JD_CLIENT_SECRET   – client_secret PISTE pour Judilibre (fallback: LF_CLIENT_SECRET)
 *   USE_SANDBOX        – "false" pour basculer sur l'API de production (défaut: sandbox)
 *   LOG_LEVEL          – "none" | "error" | "info" | "debug"  (défaut: "info")
 *   PORT               – port d'écoute (défaut: 3000)
 */

'use strict';

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const VERSION = 'v4.3.2-complet';

// ─── Logging ─────────────────────────────────────────────────────────────────

const LEVELS = { none: 0, error: 1, info: 2, debug: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const log = {
  error: (...a) => LOG_LEVEL >= LEVELS.error && console.error('[ERR]', new Date().toISOString(), ...a),
  info:  (...a) => LOG_LEVEL >= LEVELS.info  && console.log('[INF]', new Date().toISOString(), ...a),
  debug: (...a) => LOG_LEVEL >= LEVELS.debug && console.log('[DBG]', new Date().toISOString(), ...a),
};

// Middleware de logging des requêtes entrantes
app.use((req, _res, next) => {
  log.debug(`-> ${req.method} ${req.path}`, req.body || req.query);
  next();
});

// ─── Configuration ────────────────────────────────────────────────────────────

const USE_SANDBOX = process.env.USE_SANDBOX !== 'false';

const LF_BASE   = USE_SANDBOX
  ? 'https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app'
  : 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app';

const JD_BASE   = USE_SANDBOX
  ? 'https://sandbox-api.piste.gouv.fr/cassation/judilibre/v1.0'
  : 'https://api.piste.gouv.fr/cassation/judilibre/v1.0';

const OAUTH_URL = USE_SANDBOX
  ? 'https://sandbox-oauth.piste.gouv.fr/api/oauth/token'
  : 'https://oauth.piste.gouv.fr/api/oauth/token';

const LF_CLIENT_ID     = process.env.LF_CLIENT_ID     || '';
const LF_CLIENT_SECRET = process.env.LF_CLIENT_SECRET || '';
const JD_CLIENT_ID     = process.env.JD_CLIENT_ID     || LF_CLIENT_ID;
const JD_CLIENT_SECRET = process.env.JD_CLIENT_SECRET || LF_CLIENT_SECRET;

// ─── Validation des variables d'environnement au démarrage ───────────────────

function validateEnv() {
  const missing = [];
  if (!LF_CLIENT_ID)     missing.push('LF_CLIENT_ID');
  if (!LF_CLIENT_SECRET) missing.push('LF_CLIENT_SECRET');
  if (missing.length) {
    log.error('Variables manquantes: ' + missing.join(', ') + '. Toutes les requêtes upstream échoueront.');
  } else {
    log.info('Legifrance : ' + LF_BASE);
    log.info('Judilibre  : ' + JD_BASE);
    log.info('OAuth      : ' + OAUTH_URL);
    log.info('Mode       : ' + (USE_SANDBOX ? 'SANDBOX' : 'PRODUCTION'));
  }
}

// ─── Token cache ──────────────────────────────────────────────────────────────

const _tokens = {};

async function getToken(clientId, clientSecret) {
  if (!clientId || !clientSecret)
    throw new Error('Identifiants API manquants. Verifiez LF_CLIENT_ID / LF_CLIENT_SECRET.');

  const now    = Date.now();
  const cached = _tokens[clientId];
  if (cached && cached.expiresAt > now + 15_000) return cached.token;

  log.debug('OAuth: renouvellement token');
  const res = await fetch(OAUTH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'openid',
    }).toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error('OAuth ' + res.status + ': ' + txt);
  }
  const data = await res.json();
  _tokens[clientId] = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3600) * 1000 };
  log.debug('OAuth: token renouvelé, expire dans ' + (data.expires_in ?? 3600) + 's');
  return data.access_token;
}

// ─── Retry avec backoff exponentiel ──────────────────────────────────────────
// Réessaie sur 429 (rate-limit) et 503 (service indisponible).
// Sur 401, invalide le cache et réessaie une fois (token révoqué côté serveur).

const RETRY_STATUSES = new Set([429, 503]);
const RETRY_DELAYS   = [500, 1500, 4000]; // ms

async function fetchWithRetry(url, options, clientId, clientSecret) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);

    // Token révoqué avant expiration locale
    if (res.status === 401 && attempt === 0) {
      log.debug('401 recu, purge du cache token et retry');
      delete _tokens[clientId];
      const newToken = await getToken(clientId, clientSecret);
      options = { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + newToken } };
      attempt++;
      continue;
    }

    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS.length) {
      const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
      const wait = Math.max(RETRY_DELAYS[attempt], retryAfter);
      log.info(res.status + ' sur ' + url + ' — retry dans ' + wait + 'ms (tentative ' + (attempt + 1) + ')');
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      continue;
    }

    return res;
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function callLegifrance(path, payload = {}, method = 'POST') {
  const token = await getToken(LF_CLIENT_ID, LF_CLIENT_SECRET);
  const url   = LF_BASE + path;

  let options = {
    method,
    headers: {
      Authorization:  'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
  };
  if (method !== 'GET') options.body = JSON.stringify(payload);

  log.debug('LF ' + method + ' ' + path);
  const res  = await fetchWithRetry(url, options, LF_CLIENT_ID, LF_CLIENT_SECRET);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('LF ' + res.status + ' ' + path, JSON.stringify(data).slice(0, 200));
    const err = new Error('Legifrance ' + res.status + ' ' + path);
    err.status   = res.status;
    err.upstream = data;
    throw err;
  }
  return data;
}

async function callJudilibre(path, queryParams = {}) {
  const token = await getToken(JD_CLIENT_ID, JD_CLIENT_SECRET);
  const qs    = new URLSearchParams(
    Object.entries(queryParams)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, String(v)])
  ).toString();
  const url = JD_BASE + path + (qs ? '?' + qs : '');

  let options = {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  };

  log.debug('JD GET ' + path, JSON.stringify(queryParams).slice(0, 100));
  const res  = await fetchWithRetry(url, options, JD_CLIENT_ID, JD_CLIENT_SECRET);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    log.error('JD ' + res.status + ' ' + path, JSON.stringify(data).slice(0, 200));
    const err = new Error('Judilibre ' + res.status + ' ' + path);
    err.status   = res.status;
    err.upstream = data;
    throw err;
  }
  return data;
}

// ─── Helpers communs ──────────────────────────────────────────────────────────

function handleError(res, err) {
  log.error(err.message, err.upstream ? JSON.stringify(err.upstream).slice(0, 200) : '');
  return res.status(err.status ?? 500).json({
    ok: false, message: err.message,
    ...(err.upstream ? { upstream: err.upstream } : {}),
  });
}

const today = () => new Date().toISOString().split('T')[0];

// ─── Normalisation de requête ─────────────────────────────────────────────────

const normalizeWhitespace = v => String(v || '').replace(/\s+/g, ' ').trim();

function dedupeTokens(v) {
  const seen = new Set(), out = [];
  for (const tok of normalizeWhitespace(v).split(' ').filter(Boolean)) {
    const key = tok.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(tok); }
  }
  return out.join(' ');
}

function normalizeSyntaxOnly(v) {
  let q = normalizeWhitespace(v).replace(/[""]/g, '"').replace(/['']/g, "'");
  q = dedupeTokens(q);
  q = q.replace(
    /\b([LRDA]\.?(?:\s)?\d[\w.-]*)\s+(code de la sécurité sociale|css)\b/gi,
    (_, a) => 'article ' + a.replace(/\s+/g, '') + ' code de la sécurité sociale'
  );
  q = q.replace(/\b(1240|1241|1231-1)\s+code civil\b/gi, (_, a) => 'article ' + a + ' code civil');
  return normalizeWhitespace(q);
}

// ─── Détection d'intention & rerankage ────────────────────────────────────────

function detectIntent(query) {
  const q = (query || '').toLowerCase();
  const hasArt = /\barticle\b/.test(q) || /\b[lrda]\.?(?:\s)?\d[\w.-]*\b/i.test(query || '') || /\b1240\b|\b1241\b|\b1231-1\b/.test(q);
  if (/\bidcc\b|\bconvention collective\b|\bsyntec\b|\bmétallurgie\b/.test(q))     return 'KALI';
  if (/\bjorftext\b|\bnor\b|\bjournal officiel\b|\bjorf\b|\bdécret\b|\barrêté\b|\bordonnance\b/.test(q)) return 'JORF_LODA';
  if (/\bcour de cassation\b|\bjurisprudence\b|\barrêt\b|\bpourvoi\b|\becli\b/.test(q)) return 'JURISPRUDENCE';
  if (hasArt && /\bcode\b/.test(q)) return 'ARTICLE';
  if (/\bcode civil\b|\bcode de la sécurité sociale\b|\bcode du travail\b|\bcode\b/.test(q)) return 'CODE';
  return 'GENERIC';
}

const FOND_BY_INTENT = {
  ARTICLE: 'CODE_ETAT', CODE: 'CODE_ETAT', JURISPRUDENCE: 'JURI',
  JORF_LODA: 'LODA_ETAT', KALI: 'KALI', GENERIC: 'ALL',
};

function rerankByIntent(intent, results) {
  const arr = Array.isArray(results) ? [...results] : [];
  const originOf = r => String(r.origin || r.type || r.fond || r.nature || r.corpus || '').toUpperCase();
  const pm = {
    ARTICLE: ['LEGI','CODE','JURI','JORF','KALI'], CODE: ['LEGI','CODE','JURI','JORF','KALI'],
    JURISPRUDENCE: ['JURI','CASSATION','LEGI','JORF','KALI'], JORF_LODA: ['JORF','LODA','LEGI','JURI','KALI'],
    KALI: ['KALI','ACCO','LEGI','JURI','JORF'], GENERIC: ['LEGI','JURI','JORF','KALI'],
  };
  const p = pm[intent] || pm.GENERIC;
  return arr.sort((a, b) => {
    const ia = p.findIndex(x => originOf(a).includes(x));
    const ib = p.findIndex(x => originOf(b).includes(x));
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

// ─── Rerankage spécifique contentieux ────────────────────────────────────────
// Hiérarchie fixe : TEXTE → JUGE → ADMINISTRATION → PROCÉDURE

const CONTENTIEUX_LAYERS = {
  TEXTE:         ['LEGI','CODE','LEGIARTI','LEGITEXT'],
  JUGE:          ['JURI','JUFI','CETAT','CONSTIT','CASSATION'],
  ADMINISTRATION:['JORF','LODA','CIRC','DOSSIER'],
  PROCEDURE:     ['KALI','ACCO','CNIL'],
};

function detectContentieuxLayer(result) {
  const src = String(
    result.origin || result.type || result.fond ||
    result.nature || result.corpus || result.id || ''
  ).toUpperCase();
  for (const [layer, markers] of Object.entries(CONTENTIEUX_LAYERS)) {
    if (markers.some(m => src.includes(m))) return layer;
  }
  return 'AUTRE';
}

const LAYER_ORDER = ['TEXTE','JUGE','ADMINISTRATION','PROCEDURE','AUTRE'];

function rerankContentieux(results) {
  const arr = Array.isArray(results) ? [...results] : [];
  return arr.sort((a, b) => {
    const la = LAYER_ORDER.indexOf(detectContentieuxLayer(a));
    const lb = LAYER_ORDER.indexOf(detectContentieuxLayer(b));
    return la - lb;
  });
}

// ─── Constructeur SearchRequestDTO ───────────────────────────────────────────

function buildSearchPayload(query, { fond, pageSize = 10, pageNumber = 1 } = {}) {
  const intent = detectIntent(normalizeSyntaxOnly(query));
  return {
    fond: fond || FOND_BY_INTENT[intent] || 'ALL',
    recherche: {
      champs: [{ typeChamp: 'ALL', criteres: [{ typeRecherche: 'TOUS_LES_MOTS_DANS_UN_CHAMP', valeur: query, operateur: 'ET' }], operateur: 'ET' }],
      operateur: 'ET', typePagination: 'DEFAUT',
      pageSize:   Math.min(Number(pageSize) || 10, 100),
      pageNumber: Number(pageNumber) || 1,
      sort: 'PERTINENCE',
    },
  };
}

// Résout un code par nom -> textId (LEGITEXT)
async function resolveCodeId(codeTerms) {
  const list = await callLegifrance('/list/code', { codeName: codeTerms, pageSize: 3, pageNumber: 1, states: ['VIGUEUR'] });
  return (list.results || [])[0]?.cid || (list.results || [])[0]?.id || null;
}

// Résout une convention par query -> id KALI
async function resolveKaliId(query) {
  const list = await callLegifrance('/list/conventions', { titre: query, pageSize: 3, pageNumber: 1 });
  return (list.results || [])[0]?.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ─── Santé ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'proxy-avocat', version: VERSION, sandbox: USE_SANDBOX })
);

app.get('/lf/commit', async (_req, res) => {
  try { res.json({ ok: true, path_used: '/misc/commitId', ...await callLegifrance('/misc/commitId', {}, 'GET') }); }
  catch (err) { handleError(res, err); }
});

app.get('/jd/healthcheck', async (_req, res) => {
  try { res.json({ ok: true, path_used: '/healthcheck', ...await callJudilibre('/healthcheck') }); }
  catch (err) { handleError(res, err); }
});

// ─── Escape hatch ─────────────────────────────────────────────────────────────

app.post('/raw/request', async (req, res) => {
  const { api, method = 'POST', path, payload = {} } = req.body || {};
  if (!api || !path) return res.status(400).json({ ok: false, message: 'api et path sont requis' });
  try {
    if (api === 'legifrance') return res.json({ ok: true, api_used: 'legifrance', path_used: path, ...await callLegifrance(path, payload, method.toUpperCase()) });
    if (api === 'judilibre')  return res.json({ ok: true, api_used: 'judilibre',  path_used: path, ...await callJudilibre(path, payload) });
    return res.status(400).json({ ok: false, message: 'api non supportee: ' + api });
  } catch (err) { handleError(res, err); }
});

// ─── Recherche ────────────────────────────────────────────────────────────────

app.post('/lf/search-simple', async (req, res) => {
  const userQuery = req.body?.query || req.body?.terms || '';
  if (!userQuery) return res.status(400).json({ ok: false, message: 'query est requis' });
  const normalized = normalizeSyntaxOnly(userQuery);
  const intent     = detectIntent(normalized);
  try {
    const payload  = buildSearchPayload(normalized, { pageSize: req.body?.pageSize, pageNumber: req.body?.pageNumber });
    const upstream = await callLegifrance('/search', payload);
    const ranked   = rerankByIntent(intent, upstream.results || []);
    const results  = rerankContentieux(ranked);
    res.json({ ok: true, returnedCount: results.length, totalResultNumber: upstream.totalResultNumber ?? results.length, results,
      routing: { user_query: userQuery, normalized_query: normalized, intent, fond_used: payload.fond, contentieux_layer: results[0] ? detectContentieuxLayer(results[0]) : null, endpoint_called: '/lf/search-simple' } });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/search-structured-safe', async (req, res) => {
  const userQuery = req.body?.query || req.body?.terms || '';
  if (!userQuery) return res.status(400).json({ ok: false, message: 'query est requis' });
  const normalized = normalizeSyntaxOnly(userQuery);
  const intent     = detectIntent(normalized);
  try {
    const payload  = buildSearchPayload(normalized, { fond: req.body?.fond, pageSize: req.body?.pageSize, pageNumber: req.body?.pageNumber });
    const upstream = await callLegifrance('/search', payload);
    const ranked   = rerankByIntent(intent, upstream.results || []);
    const results  = rerankContentieux(ranked);
    res.json({ ok: true, returnedCount: results.length, totalResultNumber: upstream.totalResultNumber ?? results.length, results,
      routing: { user_query: userQuery, normalized_query: normalized, intent, fond_used: payload.fond, contentieux_layer: results[0] ? detectContentieuxLayer(results[0]) : null, endpoint_called: '/lf/search-structured-safe' } });
  } catch (err) { handleError(res, err); }
});

// ─── Suggestions ──────────────────────────────────────────────────────────────

// /suggest attend { searchText, supplies, documentsDits }
app.post('/lf/suggest', async (req, res) => {
  const userQuery = req.body?.query || req.body?.searchText || '';
  if (!userQuery) return res.status(400).json({ ok: false, message: 'query est requis' });
  const normalized = normalizeSyntaxOnly(userQuery);
  const intent     = detectIntent(normalized);
  try {
    const payload = { searchText: normalized, supplies: req.body?.supplies || [FOND_BY_INTENT[intent] || 'ALL'], documentsDits: req.body?.documentsDits ?? false };
    const upstream = await callLegifrance('/suggest', payload);
    const results  = rerankByIntent(intent, upstream.results || []);
    res.json({ ok: true, returnedCount: results.length, totalResultNumber: upstream.totalResultNumber ?? results.length, results,
      routing: { user_query: userQuery, normalized_query: normalized, intent, endpoint_called: '/lf/suggest' } });
  } catch (err) { handleError(res, err); }
});

// /suggest/acco attend { searchText }
app.post('/lf/suggest/acco', async (req, res) => {
  const searchText = normalizeWhitespace(req.body?.query || req.body?.searchText || '');
  if (!searchText) return res.status(400).json({ ok: false, message: 'query est requis' });
  try { res.json({ ok: true, path_used: '/suggest/acco', ...await callLegifrance('/suggest/acco', { searchText }) }); }
  catch (err) { handleError(res, err); }
});

// /suggest/pdc attend { searchText, origin?, fond? }
app.post('/lf/suggest/pdc', async (req, res) => {
  const searchText = normalizeWhitespace(req.body?.query || req.body?.searchText || '');
  if (!searchText) return res.status(400).json({ ok: false, message: 'query est requis' });
  try {
    const payload = { searchText, ...(req.body?.origin ? { origin: req.body.origin } : {}), ...(req.body?.fond ? { fond: req.body.fond } : {}) };
    res.json({ ok: true, path_used: '/suggest/pdc', ...await callLegifrance('/suggest/pdc', payload) });
  } catch (err) { handleError(res, err); }
});

// ─── Articles ─────────────────────────────────────────────────────────────────

app.post('/lf/article-resolve', async (req, res) => {
  const articleNumber = normalizeWhitespace(req.body?.articleNumber || '');
  const codeTerms     = normalizeWhitespace(req.body?.codeTerms || '');
  const userQuery     = normalizeWhitespace(req.body?.query || ((articleNumber ? 'article ' + articleNumber : '') + ' ' + codeTerms).trim());
  if (!userQuery) return res.status(400).json({ ok: false, message: 'articleNumber+codeTerms ou query est requis' });
  const normalized = normalizeSyntaxOnly(userQuery);
  try {
    const upstream = await callLegifrance('/search', buildSearchPayload(normalized, { fond: 'CODE_ETAT', pageSize: 5 }));
    const best = (upstream.results || [])[0] || null;
    res.json({ ok: true, returnedCount: best ? 1 : 0, bestMatch: best, query: normalized,
      routing: { user_query: userQuery, normalized_query: normalized, intent: 'ARTICLE', endpoint_called: '/lf/article-resolve' } });
  } catch (err) { handleError(res, err); }
});

// Stratégie en 3 étapes : getArticleWithIdAndNum -> search+getArticle -> search_only
app.post('/lf/article-fetch', async (req, res) => {
  const articleNumber = normalizeWhitespace(req.body?.articleNumber || '');
  const codeTerms     = normalizeWhitespace(req.body?.codeTerms || '');
  if (!articleNumber || !codeTerms)
    return res.status(400).json({ ok: false, message: 'articleNumber et codeTerms sont requis' });
  try {
    const textId = await resolveCodeId(codeTerms);
    if (textId) {
      try {
        const article = await callLegifrance('/consult/getArticleWithIdAndNum', { id: textId, num: articleNumber });
        return res.json({ ok: true, mode: 'consult_by_id_and_num', path_used: '/consult/getArticleWithIdAndNum', textId, article, query: 'article ' + articleNumber + ' ' + codeTerms });
      } catch { /* fallback */ }
    }
    const sr   = await callLegifrance('/search', buildSearchPayload('article ' + articleNumber + ' ' + codeTerms, { fond: 'CODE_ETAT', pageSize: 3 }));
    const best = (sr.results || [])[0] || null;
    if (best?.id && /^LEGIARTI/i.test(best.id)) {
      const full = await callLegifrance('/consult/getArticle', { id: best.id });
      return res.json({ ok: true, mode: 'consult_by_legiarti', path_used: '/consult/getArticle', article: full, query: 'article ' + articleNumber + ' ' + codeTerms });
    }
    res.json({ ok: true, mode: 'search_only', path_used: '/search', bestMatch: best, query: 'article ' + articleNumber + ' ' + codeTerms });
  } catch (err) { handleError(res, err); }
});

// Article par CID chronologique
app.post('/lf/consult/article-by-cid', async (req, res) => {
  const cid = normalizeWhitespace(req.body?.cid || '');
  if (!cid) return res.status(400).json({ ok: false, message: 'cid est requis' });
  try { res.json({ ok: true, path_used: '/consult/getArticleByCid', cid, ...await callLegifrance('/consult/getArticleByCid', { cid }) }); }
  catch (err) { handleError(res, err); }
});

// Article par ELI ou alias
app.post('/lf/consult/article-by-eli', async (req, res) => {
  const idEliOrAlias = normalizeWhitespace(req.body?.idEliOrAlias || req.body?.eli || '');
  if (!idEliOrAlias) return res.status(400).json({ ok: false, message: 'idEliOrAlias est requis' });
  try { res.json({ ok: true, path_used: '/consult/getArticleWithIdEliOrAlias', idEliOrAlias, ...await callLegifrance('/consult/getArticleWithIdEliOrAlias', { idEliOrAlias }) }); }
  catch (err) { handleError(res, err); }
});

// Articles de même numéro dans d'autres textes
app.post('/lf/consult/same-num-article', async (req, res) => {
  const { articleCid, articleNum, textCid, date } = req.body || {};
  if (!articleCid || !articleNum || !textCid)
    return res.status(400).json({ ok: false, message: 'articleCid, articleNum et textCid sont requis' });
  try { res.json({ ok: true, path_used: '/consult/sameNumArticle', ...await callLegifrance('/consult/sameNumArticle', { articleCid, articleNum, textCid, date: normalizeWhitespace(date || today()) }) }); }
  catch (err) { handleError(res, err); }
});

// ─── Codes ────────────────────────────────────────────────────────────────────

app.post('/lf/code-safe', async (req, res) => {
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || req.body?.query || '');
  if (!codeTerms) return res.status(400).json({ ok: false, message: 'codeTerms est requis' });
  try {
    const upstream = await callLegifrance('/list/code', { codeName: codeTerms, pageSize: Math.min(Number(req.body?.maxItems || 5), 100), pageNumber: 1, states: ['VIGUEUR'] });
    res.json({ ok: true, mode: 'code_lookup', code: (upstream.results || [])[0] || null,
      searchSummary: { totalResultNumber: upstream.totalResultNumber ?? (upstream.results||[]).length, returnedCount: (upstream.results||[]).length }, query_used: { codeName: codeTerms } });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/code-resolve', async (req, res) => {
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || req.body?.query || '');
  if (!codeTerms) return res.status(400).json({ ok: false, message: 'codeTerms est requis' });
  try {
    const codeList  = await callLegifrance('/list/code', { codeName: codeTerms, pageSize: 3, pageNumber: 1, states: ['VIGUEUR'] });
    const codeEntry = (codeList.results || [])[0];
    const textId    = codeEntry?.cid || codeEntry?.id || null;
    if (!textId) return res.status(404).json({ ok: false, message: 'Code introuvable: ' + codeTerms });
    const outline = await callLegifrance('/consult/legi/tableMatieres', { textId, date: today(), nature: 'CODE' });
    res.json({ ok: true, mode: 'table_matieres', textId, code: codeEntry, outline: outline.sections || outline.elements || outline, query_used: { codeTerms, textId, date: today() } });
  } catch (err) { handleError(res, err); }
});

// Texte consolidé complet – /consult/code attend { textId, date, sctCid? }
app.post('/lf/consult/code', async (req, res) => {
  const textId    = normalizeWhitespace(req.body?.textId || '');
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || '');
  const date      = normalizeWhitespace(req.body?.date || today());
  try {
    const resolvedId = textId || (codeTerms ? await resolveCodeId(codeTerms) : null);
    if (!resolvedId) return res.status(400).json({ ok: false, message: 'textId ou codeTerms est requis' });
    const result = await callLegifrance('/consult/code', { textId: resolvedId, date, ...(req.body?.sctCid ? { sctCid: req.body.sctCid } : {}), ...(req.body?.abrogated ? { abrogated: req.body.abrogated } : {}) });
    res.json({ ok: true, path_used: '/consult/code', textId: resolvedId, date, result });
  } catch (err) { handleError(res, err); }
});

// Partie d'un texte LEGI (sections) – /consult/legiPart attend { textId, date }
app.post('/lf/consult/legi-part', async (req, res) => {
  const textId    = normalizeWhitespace(req.body?.textId || '');
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || '');
  const date      = normalizeWhitespace(req.body?.date || today());
  try {
    const resolvedId = textId || (codeTerms ? await resolveCodeId(codeTerms) : null);
    if (!resolvedId) return res.status(400).json({ ok: false, message: 'textId ou codeTerms est requis' });
    const result = await callLegifrance('/consult/legiPart', { textId: resolvedId, date, ...(req.body?.searchedString ? { searchedString: req.body.searchedString } : {}) });
    res.json({ ok: true, path_used: '/consult/legiPart', textId: resolvedId, date, result });
  } catch (err) { handleError(res, err); }
});

// Versions canoniques / proches
app.post('/lf/search/canonical-version', async (req, res) => {
  const { textId, date } = req.body || {};
  if (!textId) return res.status(400).json({ ok: false, message: 'textId est requis' });
  try { res.json({ ok: true, path_used: '/search/canonicalVersion', ...await callLegifrance('/search/canonicalVersion', { textId, date: normalizeWhitespace(date || today()) }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/search/canonical-article', async (req, res) => {
  const { articleId, date } = req.body || {};
  if (!articleId) return res.status(400).json({ ok: false, message: 'articleId est requis' });
  try { res.json({ ok: true, path_used: '/search/canonicalArticleVersion', ...await callLegifrance('/search/canonicalArticleVersion', { articleId, date: normalizeWhitespace(date || today()) }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/search/nearest-version', async (req, res) => {
  const { textId, date } = req.body || {};
  if (!textId) return res.status(400).json({ ok: false, message: 'textId est requis' });
  try { res.json({ ok: true, path_used: '/search/nearestVersion', ...await callLegifrance('/search/nearestVersion', { textId, date: normalizeWhitespace(date || today()) }) }); }
  catch (err) { handleError(res, err); }
});

// ─── JORF & LODA ─────────────────────────────────────────────────────────────

app.post('/lf/jorf/get', async (req, res) => {
  const nor = normalizeWhitespace(req.body?.nor || '');
  try {
    if (nor) {
      const isTextCid = /^JORFTEXT/i.test(nor);
      const path = isTextCid ? '/consult/jorf' : '/consult/getJoWithNor';
      return res.json({ ok: true, mode: 'targeted_jorf', path_used: path, result: await callLegifrance(path, isTextCid ? { textCid: nor } : { nor }) });
    }
    res.json({ ok: true, mode: 'last_jo', path_used: '/consult/lastNJo', result: await callLegifrance('/consult/lastNJo', { nbElement: 5 }) });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/consult/last-n-jo', async (req, res) => {
  try { res.json({ ok: true, path_used: '/consult/lastNJo', result: await callLegifrance('/consult/lastNJo', { nbElement: Math.min(Number(req.body?.nbElement || 10), 100) }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/consult/get-jo-with-nor', async (req, res) => {
  const nor = normalizeWhitespace(req.body?.nor || '');
  if (!nor) return res.status(400).json({ ok: false, message: 'nor est requis' });
  try {
    const isTextCid = /^JORFTEXT/i.test(nor);
    const path = isTextCid ? '/consult/jorf' : '/consult/getJoWithNor';
    res.json({ ok: true, path_used: path, result: await callLegifrance(path, isTextCid ? { textCid: nor } : { nor }) });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/law-decree/get', async (req, res) => {
  const query = normalizeSyntaxOnly(req.body?.query || '');
  if (!query) return res.status(400).json({ ok: false, message: 'query est requis' });
  try {
    const payload  = buildSearchPayload(query, { fond: 'LODA_ETAT', pageSize: req.body?.pageSize || 10, pageNumber: req.body?.pageNumber || 1 });
    const upstream = await callLegifrance('/search', payload);
    res.json({ ok: true, path_used: '/search', totalResultNumber: upstream.totalResultNumber, results: upstream.results || [],
      routing: { user_query: req.body.query, normalized_query: query, fond_used: 'LODA_ETAT', intent: 'JORF_LODA', endpoint_called: '/lf/law-decree/get' } });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/circulaire/get', async (req, res) => {
  const query = normalizeSyntaxOnly(req.body?.query || '');
  if (!query) return res.status(400).json({ ok: false, message: 'query est requis' });
  try {
    const payload  = buildSearchPayload(query, { fond: 'CIRC', pageSize: req.body?.pageSize || 10, pageNumber: req.body?.pageNumber || 1 });
    const upstream = await callLegifrance('/search', payload);
    res.json({ ok: true, path_used: '/search', totalResultNumber: upstream.totalResultNumber, results: upstream.results || [],
      routing: { user_query: req.body.query, normalized_query: query, fond_used: 'CIRC', intent: 'JORF_LODA', endpoint_called: '/lf/circulaire/get' } });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/list/loda', async (req, res) => {
  try {
    const payload = { pageSize: Math.min(Number(req.body?.pageSize || 10), 100), pageNumber: Number(req.body?.pageNumber || 1),
      ...(req.body?.natures         ? { natures:         req.body.natures }         : {}),
      ...(req.body?.legalStatus     ? { legalStatus:     req.body.legalStatus }     : {}),
      ...(req.body?.sort            ? { sort:            req.body.sort }            : {}),
      ...(req.body?.secondSort      ? { secondSort:      req.body.secondSort }      : {}),
      ...(req.body?.signatureDate   ? { signatureDate:   req.body.signatureDate }   : {}),
      ...(req.body?.publicationDate ? { publicationDate: req.body.publicationDate } : {}),
    };
    res.json({ ok: true, path_used: '/list/loda', ...await callLegifrance('/list/loda', payload) });
  } catch (err) {
    if (err.status === 503) return res.status(503).json({ ok: false, retryable: true, message: 'Service LODA indisponible' });
    handleError(res, err);
  }
});

// ─── Dossiers législatifs ─────────────────────────────────────────────────────

app.post('/lf/consult/dossier-legislatif', async (req, res) => {
  const id = normalizeWhitespace(req.body?.id || '');
  if (!id) return res.status(400).json({ ok: false, message: 'id est requis' });
  try { res.json({ ok: true, path_used: '/consult/dossierLegislatif', id, ...await callLegifrance('/consult/dossierLegislatif', { id }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/list/dossiers-legislatifs', async (req, res) => {
  const { type, legislatureId } = req.body || {};
  if (!type || !legislatureId) return res.status(400).json({ ok: false, message: 'type et legislatureId sont requis' });
  try { res.json({ ok: true, path_used: '/list/dossiersLegislatifs', ...await callLegifrance('/list/dossiersLegislatifs', { type, legislatureId: Number(legislatureId) }) }); }
  catch (err) { handleError(res, err); }
});

// ─── CNIL ─────────────────────────────────────────────────────────────────────

app.post('/lf/consult/cnil', async (req, res) => {
  const textId = normalizeWhitespace(req.body?.textId || '');
  const query  = normalizeSyntaxOnly(req.body?.query || '');
  if (textId) {
    try { return res.json({ ok: true, mode: 'consult', path_used: '/consult/cnil', textId, result: await callLegifrance('/consult/cnil', { textId, ...(req.body?.searchedString ? { searchedString: req.body.searchedString } : {}) }) }); }
    catch (err) { return handleError(res, err); }
  }
  if (!query) return res.status(400).json({ ok: false, message: 'textId ou query est requis' });
  try {
    const upstream = await callLegifrance('/search', buildSearchPayload(query, { fond: 'CNIL', pageSize: req.body?.pageSize || 10 }));
    res.json({ ok: true, mode: 'search', path_used: '/search', totalResultNumber: upstream.totalResultNumber, results: upstream.results || [],
      routing: { query, fond_used: 'CNIL', endpoint_called: '/lf/consult/cnil' } });
  } catch (err) { handleError(res, err); }
});

// ─── KALI ─────────────────────────────────────────────────────────────────────

app.post('/lf/list/conventions', async (req, res) => {
  try {
    const payload = { pageSize: Math.min(Number(req.body?.pageSize || 10), 100), pageNumber: Number(req.body?.pageNumber || 1),
      ...(req.body?.titre       ? { titre:       req.body.titre }       : {}),
      ...(req.body?.idcc        ? { idcc:        req.body.idcc }        : {}),
      ...(req.body?.keyWords    ? { keyWords:    req.body.keyWords }    : {}),
      ...(req.body?.legalStatus ? { legalStatus: req.body.legalStatus } : {}),
      ...(req.body?.sort        ? { sort:        req.body.sort }        : {}),
    };
    res.json({ ok: true, path_used: '/list/conventions', ...await callLegifrance('/list/conventions', payload) });
  } catch (err) {
    if (err.status === 503) return res.status(503).json({ ok: false, retryable: true, message: 'Service conventions indisponible' });
    handleError(res, err);
  }
});

app.post('/lf/consult/kali-text', async (req, res) => {
  const id    = normalizeWhitespace(req.body?.id || req.body?.idcc || '');
  const query = normalizeWhitespace(req.body?.query || '');
  if (!id && !query) return res.status(400).json({ ok: false, message: 'id, idcc ou query est requis' });
  try {
    const kaliId = id || await resolveKaliId(query);
    if (!kaliId) return res.status(404).json({ ok: false, message: 'Convention introuvable: ' + query });
    res.json({ ok: true, path_used: '/consult/kaliText', id: kaliId, result: await callLegifrance('/consult/kaliText', { id: kaliId }) });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/consult/kali-cont', async (req, res) => {
  const id    = normalizeWhitespace(req.body?.id || req.body?.idcc || '');
  const query = normalizeWhitespace(req.body?.query || '');
  if (!id && !query) return res.status(400).json({ ok: false, message: 'id, idcc ou query est requis' });
  try {
    const kaliId = id || await resolveKaliId(query);
    if (!kaliId) return res.status(404).json({ ok: false, message: 'Convention introuvable: ' + query });
    res.json({ ok: true, path_used: '/consult/kaliCont', id: kaliId, result: await callLegifrance('/consult/kaliCont', { id: kaliId, ...(req.body?.searchedString ? { searchedString: req.body.searchedString } : {}) }) });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/consult/kali-cont-idcc', async (req, res) => {
  const id = normalizeWhitespace(req.body?.idcc || req.body?.id || '');
  if (!id) return res.status(400).json({ ok: false, message: 'idcc (ou id) est requis' });
  try { res.json({ ok: true, path_used: '/consult/kaliContIdcc', id, result: await callLegifrance('/consult/kaliContIdcc', { id }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/consult/kali-section', async (req, res) => {
  const id = normalizeWhitespace(req.body?.id || '');
  if (!id) return res.status(400).json({ ok: false, message: 'id est requis (identifiant de section KALI)' });
  try { res.json({ ok: true, path_used: '/consult/kaliSection', id, result: await callLegifrance('/consult/kaliSection', { id }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/consult/kali-article', async (req, res) => {
  const id = normalizeWhitespace(req.body?.id || '');
  if (!id) return res.status(400).json({ ok: false, message: 'id est requis (identifiant article KALI)' });
  try { res.json({ ok: true, path_used: '/consult/kaliArticle', id, result: await callLegifrance('/consult/kaliArticle', { id }) }); }
  catch (err) { handleError(res, err); }
});

app.post('/lf/consult/acco', async (req, res) => {
  const id    = normalizeWhitespace(req.body?.id || '');
  const query = normalizeSyntaxOnly(req.body?.query || '');
  if (id) {
    try { return res.json({ ok: true, path_used: '/consult/acco', id, result: await callLegifrance('/consult/acco', { id }) }); }
    catch (err) { return handleError(res, err); }
  }
  if (!query) return res.status(400).json({ ok: false, message: 'id ou query est requis' });
  try {
    const upstream = await callLegifrance('/search', buildSearchPayload(query, { fond: 'ACCO', pageSize: req.body?.pageSize || 10 }));
    res.json({ ok: true, mode: 'search', path_used: '/search', totalResultNumber: upstream.totalResultNumber, results: upstream.results || [],
      routing: { query, fond_used: 'ACCO', endpoint_called: '/lf/consult/acco' } });
  } catch (err) { handleError(res, err); }
});

// ─── Jurisprudence Légifrance (CETAT / CONSTIT / JUFI) ───────────────────────

app.post('/lf/juri', async (req, res) => {
  const textId = normalizeWhitespace(req.body?.textId || '');
  const query  = normalizeSyntaxOnly(req.body?.query || '');
  if (textId) {
    try { return res.json({ ok: true, mode: 'consult', path_used: '/consult/juri', textId, result: await callLegifrance('/consult/juri', { textId, ...(req.body?.searchedString ? { searchedString: req.body.searchedString } : {}) }) }); }
    catch (err) { return handleError(res, err); }
  }
  if (!query) return res.status(400).json({ ok: false, message: 'textId ou query est requis' });
  try {
    const fond = /\bconseil d[' ]état\b|\bcetat\b|\badministratif\b/i.test(query) ? 'CETAT' : /\bconseil constitu/i.test(query) ? 'CONSTIT' : 'JURI';
    const upstream = await callLegifrance('/search', buildSearchPayload(query, { fond, pageSize: req.body?.pageSize || 10 }));
    res.json({ ok: true, mode: 'search', path_used: '/search', totalResultNumber: upstream.totalResultNumber, results: upstream.results || [],
      routing: { query, fond_used: fond, endpoint_called: '/lf/juri' } });
  } catch (err) { handleError(res, err); }
});

// ─── Chronologie ─────────────────────────────────────────────────────────────

app.get('/lf/chrono/:textCid', async (req, res) => {
  const textCid = normalizeWhitespace(req.params?.textCid || '');
  if (!textCid) return res.status(400).json({ ok: false, message: 'textCid est requis' });
  try { res.json({ ok: true, path_used: '/chrono/textCid/' + textCid, result: await callLegifrance('/chrono/textCid/' + encodeURIComponent(textCid), {}, 'GET') }); }
  catch (err) { handleError(res, err); }
});

// ─── Judilibre ────────────────────────────────────────────────────────────────

app.get('/jd/search', async (req, res) => {
  const query = normalizeSyntaxOnly(req.query?.query || '');
  if (!query) return res.status(400).json({ ok: false, message: 'query est requis' });
  try {
    const params = { query, operator: req.query?.operator || 'and', page_size: Number(req.query?.page_size || 10), page: Number(req.query?.page || 0),
      ...(req.query?.field             ? { field:             req.query.field }             : {}),
      ...(req.query?.type              ? { type:              req.query.type }              : {}),
      ...(req.query?.chamber           ? { chamber:           req.query.chamber }           : {}),
      ...(req.query?.jurisdiction      ? { jurisdiction:      req.query.jurisdiction }      : {}),
      ...(req.query?.solution          ? { solution:          req.query.solution }          : {}),
      ...(req.query?.publication       ? { publication:       req.query.publication }       : {}),
      ...(req.query?.date_start        ? { date_start:        req.query.date_start }        : {}),
      ...(req.query?.date_end          ? { date_end:          req.query.date_end }          : {}),
      ...(req.query?.sort              ? { sort:              req.query.sort }              : {}),
      ...(req.query?.order             ? { order:             req.query.order }             : {}),
      ...(req.query?.resolve_references ? { resolve_references: req.query.resolve_references } : {}),
      ...(req.query?.withFileOfType    ? { withFileOfType:    req.query.withFileOfType }    : {}),
      ...(req.query?.particularInterest ? { particularInterest: req.query.particularInterest } : {}),
    };
    res.json({ ok: true, path_used: '/search', ...await callJudilibre('/search', params),
      routing: { user_query: req.query.query, normalized_query: query, intent: 'JURISPRUDENCE', endpoint_called: '/jd/search' } });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/decision', async (req, res) => {
  const id = normalizeWhitespace(req.query?.id || '');
  if (!id) return res.status(400).json({ ok: false, message: 'id est requis' });
  try {
    res.json({ ok: true, path_used: '/decision', ...await callJudilibre('/decision', { id, resolve_references: String(req.query?.resolve_references || 'false') === 'true', ...(req.query?.query ? { query: req.query.query } : {}), ...(req.query?.operator ? { operator: req.query.operator } : {}) }) });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/scan', async (req, res) => {
  try {
    const params = {
      ...(req.query?.type              ? { type:              req.query.type }                  : {}),
      ...(req.query?.chamber           ? { chamber:           req.query.chamber }               : {}),
      ...(req.query?.jurisdiction      ? { jurisdiction:      req.query.jurisdiction }          : {}),
      ...(req.query?.solution          ? { solution:          req.query.solution }              : {}),
      ...(req.query?.publication       ? { publication:       req.query.publication }           : {}),
      ...(req.query?.date_start        ? { date_start:        req.query.date_start }            : {}),
      ...(req.query?.date_end          ? { date_end:          req.query.date_end }              : {}),
      ...(req.query?.date_type         ? { date_type:         req.query.date_type }             : {}),
      ...(req.query?.order             ? { order:             req.query.order }                 : {}),
      ...(req.query?.batch_size        ? { batch_size:        Number(req.query.batch_size) }    : {}),
      ...(req.query?.search_after      ? { search_after:      req.query.search_after }          : {}),
      ...(req.query?.resolve_references ? { resolve_references: req.query.resolve_references }  : {}),
      ...(req.query?.abridged          ? { abridged:          req.query.abridged }              : {}),
      ...(req.query?.particularInterest ? { particularInterest: req.query.particularInterest }  : {}),
      ...(req.query?.withFileOfType    ? { withFileOfType:    req.query.withFileOfType }        : {}),
    };
    res.json({ ok: true, path_used: '/scan', ...await callJudilibre('/scan', params) });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/export', async (req, res) => {
  try {
    const params = {
      ...(req.query?.type              ? { type:              req.query.type }              : {}),
      ...(req.query?.chamber           ? { chamber:           req.query.chamber }           : {}),
      ...(req.query?.jurisdiction      ? { jurisdiction:      req.query.jurisdiction }      : {}),
      ...(req.query?.solution          ? { solution:          req.query.solution }          : {}),
      ...(req.query?.date_start        ? { date_start:        req.query.date_start }        : {}),
      ...(req.query?.date_end          ? { date_end:          req.query.date_end }          : {}),
      ...(req.query?.date_type         ? { date_type:         req.query.date_type }         : {}),
      ...(req.query?.order             ? { order:             req.query.order }             : {}),
      ...(req.query?.batch_size        ? { batch_size:        Number(req.query.batch_size) } : {}),
      ...(req.query?.batch             ? { batch:             Number(req.query.batch) }      : {}),
      ...(req.query?.resolve_references ? { resolve_references: req.query.resolve_references } : {}),
      ...(req.query?.abridged          ? { abridged:          req.query.abridged }          : {}),
      ...(req.query?.withFileOfType    ? { withFileOfType:    req.query.withFileOfType }    : {}),
    };
    res.json({ ok: true, path_used: '/export', ...await callJudilibre('/export', params) });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/taxonomy', async (req, res) => {
  try {
    const params = {
      ...(req.query?.id            ? { id:            req.query.id }            : {}),
      ...(req.query?.key           ? { key:           req.query.key }           : {}),
      ...(req.query?.value         ? { value:         req.query.value }         : {}),
      ...(req.query?.context_value ? { context_value: req.query.context_value } : {}),
    };
    res.json({ ok: true, path_used: '/taxonomy', ...await callJudilibre('/taxonomy', params) });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/stats', async (req, res) => {
  try {
    const params = {
      ...(req.query?.jurisdiction       ? { jurisdiction:       req.query.jurisdiction }       : {}),
      ...(req.query?.location           ? { location:           req.query.location }           : {}),
      ...(req.query?.date_start         ? { date_start:         req.query.date_start }         : {}),
      ...(req.query?.date_end           ? { date_end:           req.query.date_end }           : {}),
      ...(req.query?.particularInterest ? { particularInterest: req.query.particularInterest } : {}),
      ...(req.query?.keys               ? { keys:               req.query.keys }               : {}),
    };
    res.json({ ok: true, path_used: '/stats', ...await callJudilibre('/stats', params) });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/transactionalhistory', async (req, res) => {
  const date = normalizeWhitespace(req.query?.date || '');
  if (!date) return res.status(400).json({ ok: false, message: 'date est requis (YYYY-MM-DD)' });
  try {
    res.json({ ok: true, path_used: '/transactionalhistory', ...await callJudilibre('/transactionalhistory', { date, ...(req.query?.page_size ? { page_size: Number(req.query.page_size) } : {}), ...(req.query?.from_id ? { from_id: req.query.from_id } : {}) }) });
  } catch (err) { handleError(res, err); }
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ ok: false, message: 'Endpoint introuvable. Voir GET /health.' });
});

// ─── Démarrage & arrêt propre ─────────────────────────────────────────────────

validateEnv();
const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  log.info('proxy-avocat ' + VERSION + ' (' + (USE_SANDBOX ? 'SANDBOX' : 'PRODUCTION') + ') en ecoute sur le port ' + PORT)
);

function gracefulShutdown(signal) {
  log.info('Signal ' + signal + ' recu, fermeture propre...');
  server.close(() => { log.info('Serveur HTTP ferme.'); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
