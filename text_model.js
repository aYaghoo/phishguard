/**
 * text_model.js  --  the JS text runner: reproduces a fitted sklearn
 * TfidfVectorizer + LogisticRegression pipeline's predict_proba EXACTLY.
 *
 * Proven byte-identical to sklearn by parity_text_model.cjs. Every stage mirrors
 * sklearn's defaults (confirmed against the fitted config the exporter records):
 *   - tokenize: token_pattern (?u)\b\w\w+\b  -> words of 2+ "word" chars, lowercased
 *   - n-grams:  ngram_range (min..max), joined by single space (sklearn's join)
 *   - tf:       raw counts (sublinear_tf=False) or 1+ln(tf) if enabled
 *   - tf-idf:   tf * idf[term]   (idf already smooth-idf-baked by the exporter)
 *   - norm:     L2 (sklearn default)
 *   - clf:      sigmoid(coef . x + intercept)
 *
 * TOKENIZER NOTE: sklearn's (?u)\b\w\w+\b uses Python's Unicode \w. JS \w is
 * ASCII-only by default, so we use the Unicode-aware equivalent to match: 2+
 * consecutive Unicode word characters. This is the #1 source of TF-IDF port
 * drift; it is matched deliberately and parity-checked on unicode fixtures.
 */

'use strict';

function makeTextModel(modelJson) {
  if (!modelJson || modelJson.format !== 'phishguard-text-1') {
    throw new Error(`text_model: unrecognized format ${modelJson && modelJson.format}`);
  }
  const cfg = modelJson.config;
  const idf = modelJson.idf;
  const coef = modelJson.coef;
  const intercept = modelJson.intercept;

  // rebuild vocab map term -> index from the parallel arrays
  const vocab = new Map();
  for (let i = 0; i < modelJson.vocab_terms.length; i++) {
    vocab.set(modelJson.vocab_terms[i], modelJson.vocab_index[i]);
  }

  // sklearn token_pattern (?u)\b\w\w+\b : runs of 2+ Unicode word chars.
  // \p{L} letters, \p{N} numbers, and underscore == Python's \w for this purpose.
  const TOKEN_RE = /[\p{L}\p{N}_]{2,}/gu;

  // sklearn strip_accents: 'unicode' = NFKD then drop combining marks (Mn);
  // 'ascii' = NFKD then drop all non-ASCII. None = leave as-is. Mirrors
  // sklearn.feature_extraction.text.strip_accents_{unicode,ascii} exactly.
  function stripAccents(s) {
    const mode = cfg.strip_accents;
    if (!mode) return s; // None
    if (mode === 'ascii') {
      // NFKD, then remove non-ASCII bytes (sklearn: normalize('NFKD').encode('ascii','ignore'))
      return s.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
    }
    if (mode === 'unicode') {
      // NFKD, then strip Unicode combining marks (category Mn == \p{Mn})
      return s.normalize('NFKD').replace(/\p{Mn}/gu, '');
    }
    return s;
  }

  function tokenize(text) {
    let s = text == null ? '' : String(text);
    // Normalize to NFC first so decomposed input is composed before any accent
    // handling (deterministic regardless of the source encoding of a real email).
    s = s.normalize('NFC');
    // strip_accents runs in sklearn's PREPROCESSOR, before lowercasing+tokenizing.
    s = stripAccents(s);
    if (cfg.lowercase) s = s.toLowerCase();
    const toks = s.match(TOKEN_RE);
    return toks ? toks : [];
  }

  function ngrams(tokens) {
    // sklearn builds n-grams per _word_ngrams: for n in [min..max], join n
    // consecutive tokens with a single space. Unigrams are the tokens themselves.
    const out = [];
    const nMin = cfg.ngram_min, nMax = cfg.ngram_max;
    const L = tokens.length;
    for (let n = nMin; n <= nMax; n++) {
      if (n === 1) {
        for (let i = 0; i < L; i++) out.push(tokens[i]);
      } else {
        for (let i = 0; i + n <= L; i++) {
          out.push(tokens.slice(i, i + n).join(' '));
        }
      }
    }
    return out;
  }

  function transformRow(text) {
    // term-frequency over vocab terms only (unknown terms dropped, as sklearn does)
    const counts = new Map(); // colIndex -> raw count
    const grams = ngrams(tokenize(text));
    for (const g of grams) {
      const col = vocab.get(g);
      if (col !== undefined) {
        counts.set(col, (counts.get(col) || 0) + 1);
      }
    }
    // tf -> tfidf
    const entries = []; // [col, value]
    for (const [col, cnt] of counts) {
      let tf = cnt;
      if (cfg.sublinear_tf) tf = 1 + Math.log(cnt);
      entries.push([col, tf * idf[col]]);
    }
    // L2 normalize
    if (cfg.norm === 'l2') {
      let ss = 0;
      for (const [, v] of entries) ss += v * v;
      const nrm = Math.sqrt(ss);
      if (nrm > 0) for (const e of entries) e[1] /= nrm;
    } else if (cfg.norm === 'l1') {
      let s = 0;
      for (const [, v] of entries) s += Math.abs(v);
      if (s > 0) for (const e of entries) e[1] /= s;
    }
    return entries; // sparse [col, value]
  }

  function _sigmoid(z) {
    if (z >= 0) { const e = Math.exp(-z); return 1 / (1 + e); }
    const e = Math.exp(z); return e / (1 + e);
  }

  function scoreText(text) {
    const x = transformRow(text);
    let dot = intercept;
    for (const [col, v] of x) dot += coef[col] * v;
    return _sigmoid(dot);
  }

  return { scoreText, transformRow, tokenize, ngrams, _sigmoid };
}

// dual-mode export (Node parity + browser global)
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.TextModel = api;
  }
})(typeof self !== 'undefined' ? self : this, { makeTextModel });
