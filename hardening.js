'use strict';

const DEFAULT_MAX_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 650000);
const DEFAULT_LIMIT = Number(process.env.DEFAULT_RESPONSE_LIMIT || 50);
const MAX_STRING = Number(process.env.MAX_STRING_LENGTH || 30000);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeArticleNumber(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function exactCodeMatch(actual, expected) {
  if (!expected) return true;
  const a = normalizeText(actual);
  const e = normalizeText(expected);
  return Boolean(a) && (a === e || a.endsWith(' ' + e) || e.endsWith(' ' + a));
}

function parseArticleQuery(query) {
  const value = String(query || '').trim();
  const match = value.match(/(?:^|\b)article\s+([LRDA]?\.?\s*\d[\w.-]*)\s+(?:du\s+|de\s+la\s+|de\s+l['’]\s*)?(code\b.+)$/i);
  if (!match) return { articleNumber: '', codeTerms: '' };
  return {
    articleNumber: match[1].replace(/\s+/g, ''),
    codeTerms: match[2].trim()
  };
}

function collectionOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const keys = [
    'results', 'items', 'articles', 'listArticle', 'decisions',
    'sections', 'elements', 'nodes', 'versions', 'textes'
  ];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
    if (Array.isArray(payload.result?.[key])) return payload.result[key];
    if (Array.isArray(payload.data?.[key])) return payload.data[key];
  }
  return [];
}

function candidateArticleNumber(item) {
  return item?.articleNumber ?? item?.num ?? item?.number ?? item?.numero ?? item?.numArticle;
}

function candidateCodeTitle(item) {
  return item?.codeTitle ?? item?.code ?? item?.textTitle ?? item?.titreTexte
    ?? item?.titleText ?? item?.text?.title ?? item?.titre;
}

function selectStrictArticle(results, articleNumber, codeTerms) {
  const candidates = Array.isArray(results) ? results : collectionOf(results);
  return candidates.find(item => {
    const number = candidateArticleNumber(item);
    const code = candidateCodeTitle(item);
    const numberOk = !articleNumber ||
      normalizeArticleNumber(number) === normalizeArticleNumber(articleNumber);
    const codeOk = !codeTerms || exactCodeMatch(code, codeTerms);
    return numberOk && codeOk;
  }) || null;
}

function compactString(value, max = MAX_STRING) {
  const string = String(value);
  if (string.length <= max) return string;
  return string.slice(0, max) + '\n[contenu tronqué]';
}

const HEAVY_KEYS = new Set([
  'liens', 'links', 'relatedLinks', 'concordanceLinks',
  'nota', 'notas', 'visas', 'signers', 'dossiers',
  'file', 'files', 'attachments', 'pieces', 'documents',
  'conteneurs', 'fullTextHtml', 'html', 'raw'
]);

function compactValue(value, {
  depth = 0,
  maxDepth = 5,
  limit = DEFAULT_LIMIT,
  includeText = true,
  seen = new WeakSet()
} = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return compactString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[référence circulaire]';
  if (depth >= maxDepth) return '[profondeur limitée]';

  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, limit).map(item => compactValue(item, {
      depth: depth + 1, maxDepth, limit, includeText, seen
    }));
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (HEAVY_KEYS.has(key)) continue;
    if (!includeText && ['text', 'texte', 'content', 'contenu'].includes(key)) continue;
    out[key] = compactValue(item, {
      depth: depth + 1, maxDepth, limit, includeText, seen
    });
  }
  return out;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function summarize(payload, limit = 10) {
  const items = collectionOf(payload);
  if (items.length) {
    return {
      total: payload?.total ?? payload?.totalResultNumber ?? items.length,
      returned: Math.min(items.length, limit),
      items: items.slice(0, limit).map(item => {
        if (!item || typeof item !== 'object') return item;
        const out = {};
        for (const key of [
          'id', 'cid', 'num', 'number', 'numero', 'title', 'titre',
          'nature', 'etat', 'state', 'date', 'dateDecision',
          'decision_date', 'chamber', 'solution', 'publication'
        ]) {
          if (item[key] !== undefined) out[key] = item[key];
        }
        return out;
      })
    };
  }

  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const key of ['id', 'cid', 'title', 'titre', 'nature', 'etat', 'state', 'date']) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

function makeCompactPayload(payload, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || DEFAULT_LIMIT), 1), 1000);
  const includeText = options.includeText !== false;
  const maxDepth = Math.min(Math.max(Number(options.maxDepth || 5), 1), 10);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);

  let compacted = compactValue(payload, { limit, includeText, maxDepth });
  let truncated = byteLength(payload) > byteLength(compacted);

  if (byteLength(compacted) > maxBytes) {
    compacted = compactValue(payload, {
      limit: Math.min(limit, 20),
      includeText: false,
      maxDepth: Math.min(maxDepth, 3)
    });
    truncated = true;
  }

  if (byteLength(compacted) > maxBytes) {
    compacted = {
      ok: payload?.ok !== false,
      message: 'Réponse amont disponible mais trop volumineuse.',
      truncated: true,
      summary: summarize(payload, Math.min(limit, 10))
    };
    truncated = true;
  }

  if (compacted && typeof compacted === 'object' && !Array.isArray(compacted)) {
    compacted.meta = {
      ...(compacted.meta || {}),
      compacted: true,
      truncated,
      maxResponseBytes: maxBytes
    };
    compacted.meta.responseBytes = byteLength(compacted);
  }
  return compacted;
}

function safeSend(res, payload, options = {}) {
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
  if (byteLength(payload) <= maxBytes) return res.json(payload);
  return res.json(makeCompactPayload(payload, options));
}

function responseGuard(options = {}) {
  return (_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = payload => {
      const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
      return originalJson(byteLength(payload) > maxBytes
        ? makeCompactPayload(payload, { ...options, maxBytes })
        : payload);
    };
    next();
  };
}

function appendQueryParam(searchParams, key, value) {
  if (value === undefined || value === null || value === '') return;
  const values = Array.isArray(value)
    ? value
    : (key === 'keys' && typeof value === 'string' && value.includes(','))
      ? value.split(',').map(v => v.trim()).filter(Boolean)
      : [value];
  for (const item of values) searchParams.append(key, String(item));
}

function buildQueryString(queryParams = {}) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) appendQueryParam(searchParams, key, value);
  return searchParams.toString();
}

function isIsoDate(value) {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(Date.parse(String(value) + 'T00:00:00Z'));
}

function validateDateRange(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) return 'Les dates doivent être au format YYYY-MM-DD.';
  if (start && end && String(start) > String(end)) return 'date_start doit être antérieure ou égale à date_end.';
  return null;
}

function dateInRange(value, start, end) {
  if (!value) return false;
  const date = String(value).slice(0, 10);
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

function valuesOf(value) {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(normalizeText).filter(Boolean);
}

function filterJudilibreResults(payload, filters = {}) {
  const items = collectionOf(payload);
  if (!items.length) return payload;
  const chambers = valuesOf(filters.chamber);
  const solutions = valuesOf(filters.solution);

  const filtered = items.filter(item => {
    const chamber = item?.chamber ?? item?.chambre ?? item?.location;
    const solution = item?.solution;
    const date = item?.decision_date ?? item?.decisionDate ?? item?.dateDecision ?? item?.date;

    if (chambers.length && chamber && !chambers.includes(normalizeText(chamber))) return false;
    if (solutions.length && solution && !solutions.includes(normalizeText(solution))) return false;
    if ((filters.date_start || filters.date_end) && date && !dateInRange(date, filters.date_start, filters.date_end)) return false;
    return true;
  });

  const clone = { ...payload };
  for (const key of ['results', 'items', 'decisions']) {
    if (Array.isArray(clone[key])) clone[key] = filtered;
  }
  if (clone.result && typeof clone.result === 'object') {
    clone.result = { ...clone.result };
    for (const key of ['results', 'items', 'decisions']) {
      if (Array.isArray(clone.result[key])) clone.result[key] = filtered;
    }
  }
  clone.filterValidation = {
    requested: filters,
    dateField: 'decision_date',
    upstreamCount: items.length,
    returnedCount: filtered.length,
    filteredOut: items.length - filtered.length
  };
  return clone;
}

function selectApplicableVersion(payload, targetDate) {
  const versions = collectionOf(payload);
  return versions.find(version => {
    const start = version?.dateStart ?? version?.dateDebut ?? version?.start;
    const end = version?.dateEnd ?? version?.dateFin ?? version?.end;
    return (!start || targetDate >= String(start).slice(0, 10)) &&
      (!end || targetDate <= String(end).slice(0, 10));
  }) || null;
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_MAX_BYTES,
  buildQueryString,
  collectionOf,
  compactValue,
  dateInRange,
  exactCodeMatch,
  filterJudilibreResults,
  isIsoDate,
  makeCompactPayload,
  parseArticleQuery,
  responseGuard,
  safeSend,
  selectApplicableVersion,
  selectStrictArticle,
  validateDateRange
};
