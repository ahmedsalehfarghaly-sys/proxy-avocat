/**
 * proxy-avocat v4.3.2  –  fixed
 *
 * Prérequis : Node 18+  (fetch natif)
 *
 * Variables d'environnement :
 *   LF_CLIENT_ID       – client_id PISTE pour Légifrance
 *   LF_CLIENT_SECRET   – client_secret PISTE pour Légifrance
 *   JD_CLIENT_ID       – client_id PISTE pour Judilibre  (fallback: LF_CLIENT_ID)
 *   JD_CLIENT_SECRET   – client_secret PISTE pour Judilibre (fallback: LF_CLIENT_SECRET)
 *   USE_SANDBOX        – "false" pour basculer sur l'API de production (défaut: sandbox)
 *   PORT               – port d'écoute (défaut: 3000)
 */

'use strict';

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const VERSION = 'v4.3.2-fixed';

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

// ─── Token cache ──────────────────────────────────────────────────────────────

const _tokens = {};

async function getToken(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    throw new Error('Identifiants API manquants. Vérifiez LF_CLIENT_ID / LF_CLIENT_SECRET.');
  }
  const now = Date.now();
  const cached = _tokens[clientId];
  if (cached && cached.expiresAt > now + 15_000) return cached.token;

  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'openid',
    }).toString(),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OAuth ${res.status}: ${txt}`);
  }
  const data = await res.json();
  _tokens[clientId] = {
    token:     data.access_token,
    expiresAt: now + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function callLegifrance(path, payload = {}, method = 'POST') {
  const token = await getToken(LF_CLIENT_ID, LF_CLIENT_SECRET);
  const url   = `${LF_BASE}${path}`;

  const options = {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
  };
  if (method !== 'GET') options.body = JSON.stringify(payload);

  const res  = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Légifrance ${res.status} ${path}`);
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
  const url = `${JD_BASE}${path}${qs ? '?' + qs : ''}`;

  const res  = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Judilibre ${res.status} ${path}`);
    err.status   = res.status;
    err.upstream = data;
    throw err;
  }
  return data;
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function handleError(res, err) {
  console.error(err.message, err.upstream ?? '');
  const code = err.status ?? 500;
  return res.status(code).json({
    ok:      false,
    message: err.message,
    ...(err.upstream ? { upstream: err.upstream } : {}),
  });
}

// ─── Normalisation de requête ─────────────────────────────────────────────────

const normalizeWhitespace = v =>
  String(v || '').replace(/\s+/g, ' ').trim();

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
    (_, a) => `article ${a.replace(/\s+/g, '')} code de la sécurité sociale`
  );
  q = q.replace(
    /\b(1240|1241|1231-1)\s+code civil\b/gi,
    (_, a) => `article ${a} code civil`
  );
  return normalizeWhitespace(q);
}

// ─── Détection d'intention & rerankage ────────────────────────────────────────

function detectIntent(query) {
  const q = (query || '').toLowerCase();
  const hasArt =
    /\barticle\b/.test(q) ||
    /\b[lrda]\.?(?:\s)?\d[\w.-]*\b/i.test(query || '') ||
    /\b1240\b|\b1241\b|\b1231-1\b/.test(q);

  if (/\bidcc\b|\bconvention collective\b|\bsyntec\b|\bmétallurgie\b/.test(q))
    return 'KALI';
  if (/\bjorftext\b|\bnor\b|\bjournal officiel\b|\bjorf\b|\bdécret\b|\barrêté\b|\bordonnance\b/.test(q))
    return 'JORF_LODA';
  if (/\bcour de cassation\b|\bjurisprudence\b|\barrêt\b|\bpourvoi\b|\becli\b/.test(q))
    return 'JURISPRUDENCE';
  if (hasArt && /\bcode\b/.test(q)) return 'ARTICLE';
  if (/\bcode civil\b|\bcode de la sécurité sociale\b|\bcode du travail\b|\bcode\b/.test(q))
    return 'CODE';
  return 'GENERIC';
}

const FOND_BY_INTENT = {
  ARTICLE:      'CODE_ETAT',
  CODE:         'CODE_ETAT',
  JURISPRUDENCE:'JURI',
  JORF_LODA:    'LODA_ETAT',
  KALI:         'KALI',
  GENERIC:      'ALL',
};

function rerankByIntent(intent, results) {
  const arr = Array.isArray(results) ? [...results] : [];
  const originOf = r =>
    String(r.origin || r.type || r.fond || r.nature || r.corpus || '').toUpperCase();
  const pm = {
    ARTICLE:      ['LEGI','CODE','JURI','JORF','KALI'],
    CODE:         ['LEGI','CODE','JURI','JORF','KALI'],
    JURISPRUDENCE:['JURI','CASSATION','LEGI','JORF','KALI'],
    JORF_LODA:    ['JORF','LODA','LEGI','JURI','KALI'],
    KALI:         ['KALI','ACCO','LEGI','JURI','JORF'],
    GENERIC:      ['LEGI','JURI','JORF','KALI'],
  };
  const p = pm[intent] || pm.GENERIC;
  return arr.sort((a, b) => {
    const ia = p.findIndex(x => originOf(a).includes(x));
    const ib = p.findIndex(x => originOf(b).includes(x));
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

// ─── Constructeur de SearchRequestDTO ─────────────────────────────────────────
// Le corps de /search est un objet complexe avec fond + recherche imbriquée.

function buildSearchPayload(query, { fond, pageSize = 10, pageNumber = 1 } = {}) {
  const intent = detectIntent(normalizeSyntaxOnly(query));
  return {
    fond: fond || FOND_BY_INTENT[intent] || 'ALL',
    recherche: {
      champs: [{
        typeChamp: 'ALL',
        criteres: [{
          typeRecherche: 'TOUS_LES_MOTS_DANS_UN_CHAMP',
          valeur:        query,
          operateur:     'ET',
        }],
        operateur: 'ET',
      }],
      operateur:      'ET',
      typePagination: 'DEFAUT',
      pageSize:        Math.min(Number(pageSize) || 10, 100),
      pageNumber:      Number(pageNumber) || 1,
      sort:           'PERTINENCE',
    },
  };
}

// ─── Routes utilitaires ───────────────────────────────────────────────────────

app.get('/health', (_req, res) =>
  res.json({ ok: true, service: 'proxy-avocat', version: VERSION, sandbox: USE_SANDBOX })
);

app.get('/lf/commit', async (_req, res) => {
  try {
    const data = await callLegifrance('/misc/commitId', {}, 'GET');
    res.json({ ok: true, path_used: '/misc/commitId', ...data });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/healthcheck', async (_req, res) => {
  try {
    const data = await callJudilibre('/healthcheck');
    res.json({ ok: true, path_used: '/healthcheck', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Route générique (escape hatch) ──────────────────────────────────────────

app.post('/raw/request', async (req, res) => {
  const { api, method = 'POST', path, payload = {} } = req.body || {};
  if (!api || !path)
    return res.status(400).json({ ok: false, message: 'api et path sont requis' });

  try {
    if (api === 'legifrance') {
      const data = await callLegifrance(path, payload, method.toUpperCase());
      return res.json({ ok: true, api_used: 'legifrance', path_used: path, ...data });
    }
    if (api === 'judilibre') {
      const data = await callJudilibre(path, payload);
      return res.json({ ok: true, api_used: 'judilibre', path_used: path, ...data });
    }
    return res.status(400).json({ ok: false, message: `api non supportée: ${api}` });
  } catch (err) { handleError(res, err); }
});

// ─── Recherche Légifrance ─────────────────────────────────────────────────────

app.post('/lf/search-simple', async (req, res) => {
  const userQuery = req.body?.query || req.body?.terms || '';
  if (!userQuery)
    return res.status(400).json({ ok: false, message: 'query est requis' });

  const normalized = normalizeSyntaxOnly(userQuery);
  const intent     = detectIntent(normalized);

  try {
    const payload = buildSearchPayload(normalized, {
      pageSize:   req.body?.pageSize,
      pageNumber: req.body?.pageNumber,
    });
    const upstream = await callLegifrance('/search', payload);
    const results  = rerankByIntent(intent, upstream.results || []);
    res.json({
      ok: true,
      returnedCount:     results.length,
      totalResultNumber: upstream.totalResultNumber ?? results.length,
      results,
      routing: { user_query: userQuery, normalized_query: normalized, intent,
                 fond_used: payload.fond, endpoint_called: '/lf/search-simple' },
    });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/search-structured-safe', async (req, res) => {
  const userQuery = req.body?.query || req.body?.terms || '';
  if (!userQuery)
    return res.status(400).json({ ok: false, message: 'query est requis' });

  const normalized = normalizeSyntaxOnly(userQuery);
  const intent     = detectIntent(normalized);

  try {
    const payload = buildSearchPayload(normalized, {
      fond:       req.body?.fond,   // le client peut forcer le fond
      pageSize:   req.body?.pageSize,
      pageNumber: req.body?.pageNumber,
    });
    const upstream = await callLegifrance('/search', payload);
    const results  = rerankByIntent(intent, upstream.results || []);
    res.json({
      ok: true,
      returnedCount:     results.length,
      totalResultNumber: upstream.totalResultNumber ?? results.length,
      results,
      routing: { user_query: userQuery, normalized_query: normalized, intent,
                 fond_used: payload.fond, endpoint_called: '/lf/search-structured-safe' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── Suggestions Légifrance ───────────────────────────────────────────────────
// /suggest attend : { searchText, supplies, documentsDits }

app.post('/lf/suggest', async (req, res) => {
  const userQuery = req.body?.query || req.body?.searchText || '';
  if (!userQuery)
    return res.status(400).json({ ok: false, message: 'query est requis' });

  const normalized = normalizeSyntaxOnly(userQuery);
  const intent     = detectIntent(normalized);

  try {
    const payload = {
      searchText:   normalized,
      supplies:     req.body?.supplies || [FOND_BY_INTENT[intent] || 'ALL'],
      documentsDits: req.body?.documentsDits ?? false,
    };
    const upstream = await callLegifrance('/suggest', payload);
    const results  = rerankByIntent(intent, upstream.results || []);
    res.json({
      ok: true,
      returnedCount:     results.length,
      totalResultNumber: upstream.totalResultNumber ?? results.length,
      results,
      routing: { user_query: userQuery, normalized_query: normalized, intent,
                 endpoint_called: '/lf/suggest' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── Résolution d'article ─────────────────────────────────────────────────────

app.post('/lf/article-resolve', async (req, res) => {
  const articleNumber = normalizeWhitespace(req.body?.articleNumber || '');
  const codeTerms     = normalizeWhitespace(req.body?.codeTerms || '');
  const userQuery     = normalizeWhitespace(
    req.body?.query ||
    `${articleNumber ? `article ${articleNumber}` : ''} ${codeTerms}`.trim()
  );
  if (!userQuery)
    return res.status(400).json({ ok: false, message: 'articleNumber+codeTerms ou query est requis' });

  const normalized = normalizeSyntaxOnly(userQuery);
  try {
    const payload = buildSearchPayload(normalized, { fond: 'CODE_ETAT', pageSize: 5 });
    const upstream = await callLegifrance('/search', payload);
    const best = (upstream.results || [])[0] || null;
    res.json({
      ok: true,
      returnedCount: best ? 1 : 0,
      bestMatch:     best,
      query:         normalized,
      routing: { user_query: userQuery, normalized_query: normalized,
                 intent: 'ARTICLE', endpoint_called: '/lf/article-resolve' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── Récupération d'article (contenu complet) ─────────────────────────────────
// Stratégie :
//   1. Chercher le code via /list/code pour obtenir son LEGITEXT
//   2. Appeler /consult/getArticleWithIdAndNum avec le LEGITEXT + numéro article
//   3. Fallback /consult/getArticleByCid si l'article a un cid connu

app.post('/lf/article-fetch', async (req, res) => {
  const articleNumber = normalizeWhitespace(req.body?.articleNumber || '');
  const codeTerms     = normalizeWhitespace(req.body?.codeTerms || '');
  if (!articleNumber || !codeTerms)
    return res.status(400).json({ ok: false, message: 'articleNumber et codeTerms sont requis' });

  try {
    // Étape 1 : trouver le LEGITEXT du code
    const codeList = await callLegifrance('/list/code', {
      codeName:   codeTerms,
      pageSize:   5,
      pageNumber: 1,
    });
    const codeEntry = (codeList.results || [])[0];
    const textId    = codeEntry?.cid || codeEntry?.id || null;

    // Étape 2 : consulter l'article par LEGITEXT + numéro
    if (textId) {
      try {
        const article = await callLegifrance('/consult/getArticleWithIdAndNum', {
          id:  textId,
          num: articleNumber,
        });
        return res.json({
          ok:        true,
          mode:      'consult_by_id_and_num',
          path_used: '/consult/getArticleWithIdAndNum',
          textId,
          article,
          query:     `article ${articleNumber} ${codeTerms}`,
        });
      } catch { /* continue fallback */ }
    }

    // Étape 3 : fallback recherche plein-texte
    const searchPayload = buildSearchPayload(
      `article ${articleNumber} ${codeTerms}`, { fond: 'CODE_ETAT', pageSize: 3 }
    );
    const searchResult = await callLegifrance('/search', searchPayload);
    const best = (searchResult.results || [])[0] || null;

    // Étape 4 : si on a un id LEGIARTI, récupérer le texte complet
    if (best?.id && /^LEGIARTI/i.test(best.id)) {
      const full = await callLegifrance('/consult/getArticle', { id: best.id });
      return res.json({
        ok:        true,
        mode:      'consult_by_legiarti',
        path_used: '/consult/getArticle',
        article:   full,
        query:     `article ${articleNumber} ${codeTerms}`,
      });
    }

    res.json({
      ok:        true,
      mode:      'search_only',
      path_used: '/search',
      bestMatch: best,
      query:     `article ${articleNumber} ${codeTerms}`,
    });
  } catch (err) { handleError(res, err); }
});

// ─── Codes ────────────────────────────────────────────────────────────────────
// /list/code attend : { codeName, pageSize, pageNumber, states }

app.post('/lf/code-safe', async (req, res) => {
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || req.body?.query || '');
  if (!codeTerms)
    return res.status(400).json({ ok: false, message: 'codeTerms est requis' });

  try {
    const upstream = await callLegifrance('/list/code', {
      codeName:   codeTerms,
      pageSize:   Math.min(Number(req.body?.maxItems || 5), 100),
      pageNumber: 1,
      states:     ['VIGUEUR'],
    });
    res.json({
      ok:   true,
      mode: 'code_lookup',
      code: (upstream.results || [])[0] || null,
      searchSummary: {
        totalResultNumber: upstream.totalResultNumber ?? (upstream.results || []).length,
        returnedCount:     (upstream.results || []).length,
      },
      query_used: { codeName: codeTerms },
    });
  } catch (err) { handleError(res, err); }
});

// /consult/legi/tableMatieres attend : { textId, date, nature, sctCid }
// On résout d'abord le code pour obtenir son textId (CID).

app.post('/lf/code-resolve', async (req, res) => {
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || req.body?.query || '');
  if (!codeTerms)
    return res.status(400).json({ ok: false, message: 'codeTerms est requis' });

  try {
    // 1. Trouver le code et récupérer son CID
    const codeList = await callLegifrance('/list/code', {
      codeName:   codeTerms,
      pageSize:   3,
      pageNumber: 1,
      states:     ['VIGUEUR'],
    });
    const codeEntry = (codeList.results || [])[0];
    const textId    = codeEntry?.cid || codeEntry?.id || null;

    if (!textId) {
      return res.status(404).json({ ok: false, message: `Code introuvable: ${codeTerms}` });
    }

    // 2. Récupérer la table des matières
    const today = new Date().toISOString().split('T')[0];
    const outline = await callLegifrance('/consult/legi/tableMatieres', {
      textId,
      date:   today,
      nature: 'CODE',
    });

    res.json({
      ok:      true,
      mode:    'table_matieres',
      textId,
      code:    codeEntry,
      outline: outline.sections || outline.elements || outline,
      query_used: { codeTerms, textId, date: today },
    });
  } catch (err) { handleError(res, err); }
});

// ─── JORF ─────────────────────────────────────────────────────────────────────

app.post('/lf/jorf/get', async (req, res) => {
  const nor = normalizeWhitespace(req.body?.nor || '');
  try {
    if (nor) {
      const isTextCid = /^JORFTEXT/i.test(nor);
      const path    = isTextCid ? '/consult/jorf' : '/consult/getJoWithNor';
      const payload = isTextCid ? { textCid: nor } : { nor };
      const result  = await callLegifrance(path, payload);
      return res.json({ ok: true, mode: 'targeted_jorf', path_used: path, result });
    }
    // Sans NOR : retourner les derniers JO
    const result = await callLegifrance('/consult/lastNJo', { nbElement: 5 });
    res.json({ ok: true, mode: 'last_jo', path_used: '/consult/lastNJo', result });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/consult/last-n-jo', async (req, res) => {
  const nbElement = Math.min(Number(req.body?.nbElement || 10), 100);
  try {
    const result = await callLegifrance('/consult/lastNJo', { nbElement });
    res.json({ ok: true, path_used: '/consult/lastNJo', result });
  } catch (err) { handleError(res, err); }
});

app.post('/lf/consult/get-jo-with-nor', async (req, res) => {
  const nor = normalizeWhitespace(req.body?.nor || '');
  if (!nor)
    return res.status(400).json({ ok: false, message: 'nor est requis' });
  try {
    const isTextCid = /^JORFTEXT/i.test(nor);
    const path    = isTextCid ? '/consult/jorf' : '/consult/getJoWithNor';
    const payload = isTextCid ? { textCid: nor } : { nor };
    const result  = await callLegifrance(path, payload);
    res.json({ ok: true, path_used: path, result });
  } catch (err) { handleError(res, err); }
});

// ─── Lois & Décrets (LODA) ────────────────────────────────────────────────────

app.post('/lf/law-decree/get', async (req, res) => {
  const query = normalizeSyntaxOnly(req.body?.query || '');
  if (!query)
    return res.status(400).json({ ok: false, message: 'query est requis' });
  try {
    const payload = buildSearchPayload(query, {
      fond:       'LODA_ETAT',   // LODA_ETAT = textes en vigueur
      pageSize:   req.body?.pageSize || 10,
      pageNumber: req.body?.pageNumber || 1,
    });
    const upstream = await callLegifrance('/search', payload);
    res.json({
      ok:                true,
      path_used:         '/search',
      totalResultNumber: upstream.totalResultNumber,
      results:           upstream.results || [],
      routing: { user_query: req.body.query, normalized_query: query,
                 fond_used: 'LODA_ETAT', intent: 'JORF_LODA',
                 endpoint_called: '/lf/law-decree/get' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── Circulaires ──────────────────────────────────────────────────────────────

app.post('/lf/circulaire/get', async (req, res) => {
  const query = normalizeSyntaxOnly(req.body?.query || '');
  if (!query)
    return res.status(400).json({ ok: false, message: 'query est requis' });
  try {
    const payload = buildSearchPayload(query, {
      fond:       'CIRC',
      pageSize:   req.body?.pageSize || 10,
      pageNumber: req.body?.pageNumber || 1,
    });
    const upstream = await callLegifrance('/search', payload);
    res.json({
      ok:                true,
      path_used:         '/search',
      totalResultNumber: upstream.totalResultNumber,
      results:           upstream.results || [],
      routing: { user_query: req.body.query, normalized_query: query,
                 fond_used: 'CIRC', intent: 'JORF_LODA',
                 endpoint_called: '/lf/circulaire/get' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── LODA liste ───────────────────────────────────────────────────────────────
// /list/loda attend : { pageSize, pageNumber, natures, legalStatus, sort, ... }

app.post('/lf/list/loda', async (req, res) => {
  try {
    const payload = {
      pageSize:   Math.min(Number(req.body?.pageSize || 10), 100),
      pageNumber: Number(req.body?.pageNumber || 1),
      ...(req.body?.natures      ? { natures:      req.body.natures }      : {}),
      ...(req.body?.legalStatus  ? { legalStatus:  req.body.legalStatus }  : {}),
      ...(req.body?.sort         ? { sort:         req.body.sort }         : {}),
      ...(req.body?.secondSort   ? { secondSort:   req.body.secondSort }   : {}),
      ...(req.body?.signatureDate   ? { signatureDate:   req.body.signatureDate }   : {}),
      ...(req.body?.publicationDate ? { publicationDate: req.body.publicationDate } : {}),
    };
    const upstream = await callLegifrance('/list/loda', payload);
    res.json({ ok: true, path_used: '/list/loda', ...upstream });
  } catch (err) {
    if (err.status === 503)
      return res.status(503).json({ ok: false, retryable: true, message: 'Service LODA indisponible' });
    handleError(res, err);
  }
});

// ─── Conventions collectives (KALI) ──────────────────────────────────────────

app.post('/lf/list/conventions', async (req, res) => {
  try {
    const payload = {
      pageSize:   Math.min(Number(req.body?.pageSize || 10), 100),
      pageNumber: Number(req.body?.pageNumber || 1),
      ...(req.body?.titre       ? { titre:       req.body.titre }       : {}),
      ...(req.body?.idcc        ? { idcc:        req.body.idcc }        : {}),
      ...(req.body?.keyWords    ? { keyWords:    req.body.keyWords }    : {}),
      ...(req.body?.legalStatus ? { legalStatus: req.body.legalStatus } : {}),
      ...(req.body?.sort        ? { sort:        req.body.sort }        : {}),
    };
    const upstream = await callLegifrance('/list/conventions', payload);
    res.json({ ok: true, path_used: '/list/conventions', ...upstream });
  } catch (err) {
    if (err.status === 503)
      return res.status(503).json({ ok: false, retryable: true, message: 'Service conventions indisponible' });
    handleError(res, err);
  }
});

// ─── KALI – consultation texte ────────────────────────────────────────────────
// /consult/kaliText attend : { id } (id du texte ou d'un élément enfant)

app.post('/lf/consult/kali-text', async (req, res) => {
  // Accepte un id direct, un idcc, ou une requête textuelle via /list/conventions
  const id   = normalizeWhitespace(req.body?.id || req.body?.idcc || '');
  const query = normalizeWhitespace(req.body?.query || '');

  if (!id && !query)
    return res.status(400).json({ ok: false, message: 'id, idcc ou query est requis' });

  try {
    let kaliId = id;

    // Si on n'a pas d'id mais une requête textuelle, résoudre via /list/conventions
    if (!kaliId && query) {
      const convList = await callLegifrance('/list/conventions', {
        titre:      query,
        pageSize:   3,
        pageNumber: 1,
      });
      kaliId = (convList.results || [])[0]?.id || '';
      if (!kaliId)
        return res.status(404).json({ ok: false, message: `Convention introuvable: ${query}` });
    }

    const result = await callLegifrance('/consult/kaliText', { id: kaliId });
    res.json({ ok: true, path_used: '/consult/kaliText', id: kaliId, result });
  } catch (err) { handleError(res, err); }
});

// /consult/kaliContIdcc attend : { id } (id = numéro IDCC ou identifiant)

app.post('/lf/consult/kali-cont-idcc', async (req, res) => {
  // Le champ API s'appelle "id", pas "idcc"
  const id = normalizeWhitespace(req.body?.idcc || req.body?.id || '');
  if (!id)
    return res.status(400).json({ ok: false, message: 'idcc (ou id) est requis' });
  try {
    const result = await callLegifrance('/consult/kaliContIdcc', { id });
    res.json({ ok: true, path_used: '/consult/kaliContIdcc', id, result });
  } catch (err) { handleError(res, err); }
});

// ─── Judilibre ────────────────────────────────────────────────────────────────

app.get('/jd/search', async (req, res) => {
  const query = normalizeSyntaxOnly(req.query?.query || '');
  if (!query)
    return res.status(400).json({ ok: false, message: 'query est requis' });

  try {
    const params = {
      query,
      operator:          req.query?.operator          || 'and',
      page_size:         Number(req.query?.page_size  || 10),
      page:              Number(req.query?.page        || 0),
      ...(req.query?.field        ? { field:        req.query.field }        : {}),
      ...(req.query?.type         ? { type:         req.query.type }         : {}),
      ...(req.query?.chamber      ? { chamber:      req.query.chamber }      : {}),
      ...(req.query?.jurisdiction ? { jurisdiction: req.query.jurisdiction } : {}),
      ...(req.query?.solution     ? { solution:     req.query.solution }     : {}),
      ...(req.query?.date_start   ? { date_start:   req.query.date_start }   : {}),
      ...(req.query?.date_end     ? { date_end:     req.query.date_end }     : {}),
      ...(req.query?.sort         ? { sort:         req.query.sort }         : {}),
      ...(req.query?.order        ? { order:        req.query.order }        : {}),
      ...(req.query?.resolve_references ? { resolve_references: req.query.resolve_references } : {}),
    };
    const data = await callJudilibre('/search', params);
    res.json({
      ok:   true,
      path_used: '/search',
      ...data,
      routing: { user_query: req.query.query, normalized_query: query,
                 intent: 'JURISPRUDENCE', endpoint_called: '/jd/search' },
    });
  } catch (err) { handleError(res, err); }
});

app.get('/jd/decision', async (req, res) => {
  const id                = normalizeWhitespace(req.query?.id || '');
  const resolve_references = String(req.query?.resolve_references || 'false') === 'true';
  if (!id)
    return res.status(400).json({ ok: false, message: 'id est requis' });
  try {
    const data = await callJudilibre('/decision', {
      id,
      resolve_references,
      ...(req.query?.query    ? { query:    req.query.query }    : {}),
      ...(req.query?.operator ? { operator: req.query.operator } : {}),
    });
    res.json({ ok: true, path_used: '/decision', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Jurisprudence Légifrance (CETAT / JUFI / CONSTIT) ───────────────────────
// Distinct de Judilibre : couvre Conseil d'État, Conseil constitutionnel, etc.

app.post('/lf/juri', async (req, res) => {
  const textId = normalizeWhitespace(req.body?.textId || '');
  const query  = normalizeSyntaxOnly(req.body?.query || '');

  if (textId) {
    // Consultation directe par textId connu
    try {
      const result = await callLegifrance('/consult/juri', {
        textId,
        ...(req.body?.searchedString ? { searchedString: req.body.searchedString } : {}),
      });
      return res.json({ ok: true, mode: 'consult', path_used: '/consult/juri', result });
    } catch (err) { return handleError(res, err); }
  }

  if (!query)
    return res.status(400).json({ ok: false, message: 'textId ou query est requis' });

  // Recherche full-text, fonds JURI / CETAT / CONSTIT détectés automatiquement
  try {
    const fond = /\bconseil d[' ]état\b|\bcetat\b|\badministratif\b/i.test(query)
      ? 'CETAT'
      : /\bconseil constitu/i.test(query) ? 'CONSTIT' : 'JURI';
    const payload  = buildSearchPayload(query, { fond, pageSize: req.body?.pageSize || 10 });
    const upstream = await callLegifrance('/search', payload);
    res.json({
      ok: true, mode: 'search', path_used: '/search',
      totalResultNumber: upstream.totalResultNumber,
      results: upstream.results || [],
      routing: { query, fond_used: fond, endpoint_called: '/lf/juri' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── Consultation d'un code Légifrance (texte consolidé complet) ───────────────
// /consult/code attend : { textId (LEGITEXT…), date, sctCid? }

app.post('/lf/consult/code', async (req, res) => {
  const textId   = normalizeWhitespace(req.body?.textId || '');
  const codeTerms = normalizeWhitespace(req.body?.codeTerms || '');
  const date      = normalizeWhitespace(req.body?.date || new Date().toISOString().split('T')[0]);

  try {
    let resolvedTextId = textId;

    // Si on n'a pas de textId, résoudre via /list/code
    if (!resolvedTextId && codeTerms) {
      const codeList = await callLegifrance('/list/code', {
        codeName:   codeTerms,
        pageSize:   3,
        pageNumber: 1,
        states:     ['VIGUEUR'],
      });
      resolvedTextId = (codeList.results || [])[0]?.cid || '';
      if (!resolvedTextId)
        return res.status(404).json({ ok: false, message: `Code introuvable: ${codeTerms}` });
    }

    if (!resolvedTextId)
      return res.status(400).json({ ok: false, message: 'textId ou codeTerms est requis' });

    const result = await callLegifrance('/consult/code', {
      textId:   resolvedTextId,
      date,
      ...(req.body?.sctCid    ? { sctCid:    req.body.sctCid }    : {}),
      ...(req.body?.abrogated ? { abrogated: req.body.abrogated } : {}),
    });
    res.json({ ok: true, path_used: '/consult/code', textId: resolvedTextId, date, result });
  } catch (err) { handleError(res, err); }
});

// ─── Accords d'entreprise (ACCO) ─────────────────────────────────────────────

app.post('/lf/consult/acco', async (req, res) => {
  const id    = normalizeWhitespace(req.body?.id || '');
  const query = normalizeSyntaxOnly(req.body?.query || '');

  if (id) {
    try {
      const result = await callLegifrance('/consult/acco', { id });
      return res.json({ ok: true, path_used: '/consult/acco', id, result });
    } catch (err) { return handleError(res, err); }
  }

  if (!query)
    return res.status(400).json({ ok: false, message: 'id ou query est requis' });

  try {
    const payload  = buildSearchPayload(query, { fond: 'ACCO', pageSize: req.body?.pageSize || 10 });
    const upstream = await callLegifrance('/search', payload);
    res.json({
      ok: true, mode: 'search', path_used: '/search',
      totalResultNumber: upstream.totalResultNumber,
      results: upstream.results || [],
      routing: { query, fond_used: 'ACCO', endpoint_called: '/lf/consult/acco' },
    });
  } catch (err) { handleError(res, err); }
});

// ─── Historique chronologique d'un texte ─────────────────────────────────────

app.get('/lf/chrono/:textCid', async (req, res) => {
  const textCid = normalizeWhitespace(req.params?.textCid || '');
  if (!textCid)
    return res.status(400).json({ ok: false, message: 'textCid est requis' });
  try {
    const result = await callLegifrance(`/chrono/textCid/${encodeURIComponent(textCid)}`, {}, 'GET');
    res.json({ ok: true, path_used: `/chrono/textCid/${textCid}`, result });
  } catch (err) { handleError(res, err); }
});

// ─── Judilibre – scan (export par lot) ───────────────────────────────────────

app.get('/jd/scan', async (req, res) => {
  try {
    const params = {
      ...(req.query?.type              ? { type:              req.query.type }              : {}),
      ...(req.query?.chamber           ? { chamber:           req.query.chamber }           : {}),
      ...(req.query?.jurisdiction      ? { jurisdiction:      req.query.jurisdiction }      : {}),
      ...(req.query?.solution          ? { solution:          req.query.solution }          : {}),
      ...(req.query?.publication       ? { publication:       req.query.publication }       : {}),
      ...(req.query?.date_start        ? { date_start:        req.query.date_start }        : {}),
      ...(req.query?.date_end          ? { date_end:          req.query.date_end }          : {}),
      ...(req.query?.date_type         ? { date_type:         req.query.date_type }         : {}),
      ...(req.query?.order             ? { order:             req.query.order }             : {}),
      ...(req.query?.batch_size        ? { batch_size:        Number(req.query.batch_size) } : {}),
      ...(req.query?.search_after      ? { search_after:      req.query.search_after }      : {}),
      ...(req.query?.resolve_references ? { resolve_references: req.query.resolve_references } : {}),
      ...(req.query?.abridged          ? { abridged:          req.query.abridged }          : {}),
      ...(req.query?.particularInterest ? { particularInterest: req.query.particularInterest } : {}),
    };
    const data = await callJudilibre('/scan', params);
    res.json({ ok: true, path_used: '/scan', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Judilibre – export (lot numéroté) ───────────────────────────────────────

app.get('/jd/export', async (req, res) => {
  try {
    const params = {
      ...(req.query?.type         ? { type:         req.query.type }         : {}),
      ...(req.query?.chamber      ? { chamber:      req.query.chamber }      : {}),
      ...(req.query?.jurisdiction ? { jurisdiction: req.query.jurisdiction } : {}),
      ...(req.query?.solution     ? { solution:     req.query.solution }     : {}),
      ...(req.query?.date_start   ? { date_start:   req.query.date_start }   : {}),
      ...(req.query?.date_end     ? { date_end:     req.query.date_end }     : {}),
      ...(req.query?.date_type    ? { date_type:    req.query.date_type }    : {}),
      ...(req.query?.order        ? { order:        req.query.order }        : {}),
      ...(req.query?.batch_size   ? { batch_size:   Number(req.query.batch_size) } : {}),
      ...(req.query?.batch        ? { batch:        Number(req.query.batch) }       : {}),
      ...(req.query?.resolve_references ? { resolve_references: req.query.resolve_references } : {}),
      ...(req.query?.abridged     ? { abridged:     req.query.abridged }     : {}),
    };
    const data = await callJudilibre('/export', params);
    res.json({ ok: true, path_used: '/export', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Judilibre – taxonomie ────────────────────────────────────────────────────

app.get('/jd/taxonomy', async (req, res) => {
  try {
    const params = {
      ...(req.query?.id            ? { id:            req.query.id }            : {}),
      ...(req.query?.key           ? { key:           req.query.key }           : {}),
      ...(req.query?.value         ? { value:         req.query.value }         : {}),
      ...(req.query?.context_value ? { context_value: req.query.context_value } : {}),
    };
    const data = await callJudilibre('/taxonomy', params);
    res.json({ ok: true, path_used: '/taxonomy', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Judilibre – statistiques ─────────────────────────────────────────────────

app.get('/jd/stats', async (req, res) => {
  try {
    const params = {
      ...(req.query?.jurisdiction      ? { jurisdiction:      req.query.jurisdiction }      : {}),
      ...(req.query?.location          ? { location:          req.query.location }          : {}),
      ...(req.query?.date_start        ? { date_start:        req.query.date_start }        : {}),
      ...(req.query?.date_end          ? { date_end:          req.query.date_end }          : {}),
      ...(req.query?.particularInterest ? { particularInterest: req.query.particularInterest } : {}),
      ...(req.query?.keys              ? { keys:              req.query.keys }              : {}),
    };
    const data = await callJudilibre('/stats', params);
    res.json({ ok: true, path_used: '/stats', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Judilibre – historique transactionnel ────────────────────────────────────

app.get('/jd/transactionalhistory', async (req, res) => {
  const date = normalizeWhitespace(req.query?.date || '');
  if (!date)
    return res.status(400).json({ ok: false, message: 'date est requis (YYYY-MM-DD)' });
  try {
    const params = {
      date,
      ...(req.query?.page_size ? { page_size: Number(req.query.page_size) } : {}),
      ...(req.query?.from_id   ? { from_id:   req.query.from_id }           : {}),
    };
    const data = await callJudilibre('/transactionalhistory', params);
    res.json({ ok: true, path_used: '/transactionalhistory', ...data });
  } catch (err) { handleError(res, err); }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`proxy-avocat ${VERSION} (${USE_SANDBOX ? 'SANDBOX' : 'PRODUCTION'}) listening on ${PORT}`)
);
