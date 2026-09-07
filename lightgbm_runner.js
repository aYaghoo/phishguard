/**
 * PhishGuard v3 — Module 3 (part 1): the LightGBM Runner (lightgbm_runner.js)
 *
 * Browser port of lightgbm_runner.py (same scoring-contract logic, 1:1). Runs in
 * the offscreen document.
 *
 * Responsibility (one job): given the informative structured vector (features[]
 * from the Feature Extractor), return { pStruct, contributions } and nothing
 * else. Pure structured-side inference: score the trees' raw margin, apply the
 * Platt sigmoid, emit per-feature contributions, and hold the brand feature(s)
 * off the interpretability surface for now. Never sees rule_fires[]. No fusion,
 * no router, no verdict.
 *
 * Port split (the inverse of Modules 1-2, flagged honestly in the .py):
 *   (1) training and calibration are Python-native (lightgbm/sklearn) — see the
 *       .py train_lightgbm / fit_platt / fit_baseline. That produces the artifact
 *       (tree dump + Platt (a,b) + the recorded baseline number).
 *   (2) the scoring contract itself (this file) — pure functions of a
 *       trained-model handle and a feature vector: the Platt squash, the
 *       arity/NaN guards, the display filter, and the severity ranking. Identical
 *       semantics to the .py, so p_struct cannot silently desync across ports. In
 *       deployment the handle is the pure-JS tree-walk model from
 *       lightgbm_model.js (makeStructModel over the exported JSON tree dump); the
 *       tests inject a plain-object fake handle, so the same scoring-contract
 *       logic runs under either.
 *
 * Design notes (mirror the .py):
 *   - DISPLAY_EXCLUDED_FEATURES = { sender_brand_mismatch } — computed into the
 *     score, filtered out of the displayed contributions for now.
 *   - monotoneConstraints(): +1 on url_domain_entropy, subdomain_count,
 *     sender_brand_mismatch; 0 on url_count, has_url. Positional, aligned to
 *     _INFORMATIVE_FEATURES; fails loud on an undecided new feature.
 *   - a Contribution.value is the signed SHAP contribution on the raw margin;
 *     the model handle drops LightGBM's trailing base term, so the runner sees
 *     features-only contributions.
 *   - CONTRIBUTIONS_UNAVAILABLE: a handle that cannot produce attribution returns
 *     this sentinel, and scoreStruct emits contributions: []. Whether attribution
 *     exists at all is the handle's fact, not the runner's. The shipped JS handle
 *     (lightgbm_model.js) has no tree-SHAP yet and uses it, so no unearned
 *     feature name can reach the display surface. Only this exact value is a
 *     sentinel — every other non-conforming shape still fails loud on the arity
 *     guard below.
 */

'use strict';

// ONE feature ordering, imported from the extractor (the retraining seam). Never
// re-declared here --- a second copy would be a second source of truth.
// dual-mode import: require in Node (parity tests), global in browser (offscreen,
// where feature_extractor.js loads first and exposes self.FeatureExtractor).
const _INFORMATIVE_FEATURES = (typeof require !== 'undefined')
  ? require('./feature_extractor.js').INFORMATIVE_FEATURES
  : (typeof self !== 'undefined' && self.FeatureExtractor
      ? self.FeatureExtractor.INFORMATIVE_FEATURES
      : (() => { throw new Error('lightgbm_runner: FeatureExtractor global not loaded (check offscreen.html script order)'); })());

// Display exclusion. Single point of truth.
const DISPLAY_EXCLUDED_FEATURES = Object.freeze(['sender_brand_mismatch']);

// The "this handle has no attribution" sentinel a StructModel returns from
// marginContributions. Mirrors lightgbm_runner.py's CONTRIBUTIONS_UNAVAILABLE
// (None), so the two ports agree on the value and on what it means.
const CONTRIBUTIONS_UNAVAILABLE = null;

// Monotone directions by name; materialized positionally below.
const _MONOTONE_BY_NAME = Object.freeze({
  url_count: 0,
  has_url: 0,
  url_domain_entropy: 1,
  subdomain_count: 1,
  sender_brand_mismatch: 1,
});

function monotoneConstraints() {
  const missing = _INFORMATIVE_FEATURES.filter((f) => !(f in _MONOTONE_BY_NAME));
  if (missing.length) {
    throw new Error(
      `monotone constraint undecided for feature(s) ${missing.join(', ')}; a new ` +
        'informative feature must have its direction pinned in _MONOTONE_BY_NAME ' +
        '(do not default silently)'
    );
  }
  return _INFORMATIVE_FEATURES.map((f) => _MONOTONE_BY_NAME[f]);
}

// numerically stable logistic
function _sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1.0 / (1.0 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1.0 + ez);
}

// The internal consistency guard (fail-loud, O-1 discipline): the runner is
// handed the EXACT informative vector. Wrong arity => extractor/model desync =>
// silently-wrong p_struct if scored. NaN => corrupt vector (extractor never
// emits NaN; missing is 0.0). Refuse, do not mis-score.
function _validateVector(features) {
  const n = _INFORMATIVE_FEATURES.length;
  if (!Array.isArray(features) || features.length !== n) {
    throw new Error(
      `scoreStruct: feature vector arity ${features && features.length} != ${n} ` +
        '(the informative-vector contract): extractor/model desync, not a scoreable row.'
    );
  }
  for (let i = 0; i < n; i++) {
    const v = features[i];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      throw new Error(
        `scoreStruct: feature[${i}] (${_INFORMATIVE_FEATURES[i]}) is ${v}; the ` +
          'extractor emits finite numbers (missing is 0.0), so this is a corrupt vector.'
      );
    }
  }
}

/**
 * Score ONE informative vector. Returns { pStruct, contributions }.
 * model is a StructModel handle: { rawMargin(features)->number,
 * marginContributions(features)->number[] (features-only, base term dropped)
 * or CONTRIBUTIONS_UNAVAILABLE when the handle cannot attribute,
 * platt()->[a,b] }.
 */
function scoreStruct(model, features) {
  _validateVector(features);

  const margin = model.rawMargin(features);
  const [a, b] = model.platt();
  const pStruct = _sigmoid(a * margin + b);

  const rawContribs = model.marginContributions(features);
  // The handle declares it cannot attribute this row, so there is nothing
  // displayable and the contribution list is empty — not a row of zeros wearing
  // feature names. Checked before the arity guard because the sentinel is a valid
  // answer, not a mis-shaped one. `undefined` is deliberately not accepted here,
  // so a handle that simply forgot to return still fails loud below.
  if (rawContribs === CONTRIBUTIONS_UNAVAILABLE) {
    return { pStruct, contributions: [] };
  }
  if (!Array.isArray(rawContribs) || rawContribs.length !== _INFORMATIVE_FEATURES.length) {
    throw new Error(
      `scoreStruct: model returned ${rawContribs && rawContribs.length} contributions ` +
        `for ${_INFORMATIVE_FEATURES.length} features; the base/expected-value term must ` +
        'be dropped by the handle before this point.'
    );
  }

  const contributions = [];
  for (let i = 0; i < _INFORMATIVE_FEATURES.length; i++) {
    const name = _INFORMATIVE_FEATURES[i];
    // Brand features move the score (already in the margin) but are not
    // displayed for now. A display filter, not a score edit.
    if (DISPLAY_EXCLUDED_FEATURES.includes(name)) continue;
    contributions.push({ feature: name, value: Number(rawContribs[i]) });
  }
  // Severity order: strongest push toward phishing first. Sign and rank are
  // Platt-invariant, so ranking on the margin is the same as ranking on pStruct.
  contributions.sort((x, y) => y.value - x.value);

  return { pStruct, contributions };
}

(function(){
const __api = {
  INFORMATIVE_FEATURES: _INFORMATIVE_FEATURES,
  DISPLAY_EXCLUDED_FEATURES,
  CONTRIBUTIONS_UNAVAILABLE,
  monotoneConstraints,
  scoreStruct,
  _sigmoid, // exposed for cross-port parity tests
};


// dual-mode export (Node CommonJS for parity + browser global for offscreen)
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.LightGBMRunner = api;
  }
})(typeof self !== 'undefined' ? self : this, __api);
})();

