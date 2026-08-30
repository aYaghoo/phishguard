/**
 * PhishGuard v3 --- Module 3 (part 1): the LightGBM Runner (lightgbm_runner.js)
 *
 * Browser port of lightgbm_runner.py (same SCORING contract logic, 1:1). Runs in
 * the OFFSCREEN document. Implementation Companion v1.6 (module roster; Milestone
 * table row 3); blueprint phishguard_v3 sec.model + sec.calibchain +
 * C-a/C-c/C-g/C-i; sec.features sec.D; Addendum 1 A-6; Addendum 2 contribution-
 * vs-trigger.
 *
 * Responsibility (roster, ONE job): given the informative structured vector
 * (features[] from the Feature Extractor), return { pStruct, contributions } and
 * NOTHING else. Pure structured-side inference: score the trees' raw margin,
 * apply the Platt sigmoid (C-a/calibchain), emit per-feature contributions
 * (C-i), and hold the brand feature(s) OFF the interpretability surface until R4
 * (C-g). Never sees rule_fires[] (T-1). No fusion, no router, no verdict.
 *
 * PORT SPLIT (the INVERSE of Modules 1-2, flagged honestly in the .py):
 *   (1) TRAINING + CALIBRATION is Python-native (lightgbm/sklearn) --- see the
 *       .py train_lightgbm / fit_platt / fit_baseline. That produces the ARTIFACT
 *       (tree dump + Platt (a,b) + the recorded baseline number).
 *   (2) SCORING CONTRACT LOGIC (this file) --- pure functions of a trained-model
 *       HANDLE and a feature vector: the Platt squash, the arity/NaN guards, the
 *       C-g display filter, and the severity ranking. Identical semantics to the
 *       .py, so p_struct cannot silently desync across ports. In deployment the
 *       handle wraps an ONNX Runtime Web session over the tree dump; the tests
 *       inject a plain-object fake handle, so the logic runs without ONNX.
 *
 * SEAMS (mirror the .py; do not silently resolve):
 *   [LR-alpha] DISPLAY_EXCLUDED_FEATURES = { sender_brand_mismatch } --- computed
 *              into the score, filtered from the DISPLAYED contributions until R4.
 *   [LR-beta]  monotoneConstraints(): +1 on url_domain_entropy, subdomain_count,
 *              sender_brand_mismatch; 0 on url_count, has_url. Positional, aligned
 *              to _INFORMATIVE_FEATURES; fails loud on an undecided new feature.
 *   [LR-gamma] a Contribution.value is the signed SHAP contribution on the RAW
 *              MARGIN; the model handle drops LightGBM's trailing base term so the
 *              runner sees features-only contributions.
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

// [LR-alpha] display exclusion. Single point of truth.
const DISPLAY_EXCLUDED_FEATURES = Object.freeze(['sender_brand_mismatch']);

// [LR-beta] monotone directions by name; materialized positionally below.
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
 * marginContributions(features)->number[] (features-only, base term dropped),
 * platt()->[a,b] }.
 */
function scoreStruct(model, features) {
  _validateVector(features);

  const margin = model.rawMargin(features);
  const [a, b] = model.platt();
  const pStruct = _sigmoid(a * margin + b);

  const rawContribs = model.marginContributions(features);
  if (!Array.isArray(rawContribs) || rawContribs.length !== _INFORMATIVE_FEATURES.length) {
    throw new Error(
      `scoreStruct: model returned ${rawContribs && rawContribs.length} contributions ` +
        `for ${_INFORMATIVE_FEATURES.length} features; the base/expected-value term must ` +
        'be dropped by the handle before this point ([LR-gamma]).'
    );
  }

  const contributions = [];
  for (let i = 0; i < _INFORMATIVE_FEATURES.length; i++) {
    const name = _INFORMATIVE_FEATURES[i];
    // [LR-alpha] C-g: brand features move the score (already in the margin) but
    // are NOT displayed until R4. A DISPLAY filter, not a score edit.
    if (DISPLAY_EXCLUDED_FEATURES.includes(name)) continue;
    contributions.push({ feature: name, value: Number(rawContribs[i]) });
  }
  // C-i/C-k severity order: strongest push toward phishing first. Sign/rank are
  // Platt-invariant ([LR-gamma]), so ranking on the margin == ranking on pStruct.
  contributions.sort((x, y) => y.value - x.value);

  return { pStruct, contributions };
}

(function(){
const __api = {
  INFORMATIVE_FEATURES: _INFORMATIVE_FEATURES,
  DISPLAY_EXCLUDED_FEATURES,
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

