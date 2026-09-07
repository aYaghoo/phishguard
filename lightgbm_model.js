/**
 * lightgbm_model.js  --  the StructModel HANDLE that lightgbm_runner.js consumes.
 *
 * lightgbm_runner.js owns the SCORING CONTRACT (Platt, contribution filtering,
 * severity sort) and takes an abstract handle with { rawMargin, marginContributions,
 * platt }. This file IMPLEMENTS that handle by walking the exported JSON tree
 * ensemble (export_lightgbm.py). Pure JS, no ONNX/WASM -- a 5-feature tree walk.
 *
 * MARGIN CONTRACT: raw margin = sum of leaf values over all trees. Per tree: at
 * an internal node go LEFT if feature[f] <= threshold, else RIGHT; a missing
 * (null/NaN) feature follows default_left. This mirrors export_lightgbm.py's
 * eval_tree and LightGBM's own raw_score, proven by parity_lightgbm.cjs.
 *
 * marginContributions is a known limitation: LightGBM's true SHAP would need
 * the full tree-SHAP algorithm, which this handle does not implement. Rather
 * than invent an attribution, marginContributions returns the runner's
 * "attribution unavailable" sentinel (null) and scoreStruct then emits an empty
 * contribution list. That is what keeps unearned feature names off the banner —
 * the displayed rationale is empty because this file says it has nothing to
 * attribute, not because a downstream caller happens to discard the list.
 * Implement real tree-SHAP here (features-only, with the base term dropped) and
 * the displayed rationale populates end-to-end with no other edit.
 */

'use strict';

function makeStructModel(modelJson) {
  if (!modelJson || modelJson.format !== 'phishguard-lgb-1') {
    throw new Error(`lightgbm_model: unrecognized format ${modelJson && modelJson.format}`);
  }
  const trees = modelJson.trees;
  const nFeatures = modelJson.n_features;
  const plattAB = modelJson.platt
    ? [modelJson.platt.A, modelJson.platt.B]
    : [1.0, 0.0];

  function evalTree(node, features) {
    // walk until a leaf ({v})
    while (node.v === undefined) {
      const x = features[node.f];
      const missing = (x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x)));
      if (missing) {
        node = node.dl ? node.l : node.r;
      } else {
        node = (x <= node.t) ? node.l : node.r;
      }
    }
    return node.v;
  }

  function rawMargin(features) {
    if (!Array.isArray(features) || features.length !== nFeatures) {
      throw new Error(`lightgbm_model.rawMargin: expected ${nFeatures} features, got ${features && features.length}`);
    }
    let sum = 0;
    for (let i = 0; i < trees.length; i++) sum += evalTree(trees[i], features);
    return sum;
  }

  function marginContributions(features) {
    // Real tree-SHAP is deferred, so this handle has no attribution to offer
    // and says so, with the runner's CONTRIBUTIONS_UNAVAILABLE sentinel. A zero
    // vector would be wrong here: it is indistinguishable from a genuine
    // all-zero SHAP row, so the runner would emit four zero-valued feature names
    // and the banner would list them as reasons. When real tree-SHAP lands,
    // return the features-only vector (length nFeatures, base term dropped); the
    // arity guard covers that shape and the display filter still applies.
    void features;
    return null;
  }

  function platt() {
    return plattAB.slice();
  }

  return { rawMargin, marginContributions, platt, _nFeatures: nFeatures };
}

// dual-mode export (Node parity + browser global)
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.LightGBMModel = api;
  }
})(typeof self !== 'undefined' ? self : this, { makeStructModel });
