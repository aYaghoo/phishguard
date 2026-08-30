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
 * marginContributions: LightGBM's true SHAP would need the full tree-SHAP algo.
 * For v1 the runner only DISPLAYS contributions (C-g/[LR-alpha]) and in v1 the
 * brand feature is display-excluded and the map is empty, so a faithful but
 * simple per-feature attribution is acceptable here as a SEAM. [LGB-contrib]:
 * we return a gain-free placeholder attribution (all zeros) so the runner's
 * arity check passes; real tree-SHAP is deferred until contributions are shown
 * (R4). This is flagged, not silently faked -- the DISPLAYED rationale in v1
 * comes from rules/[], not these (composeRationale on the routed/■ path).
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
    // [LGB-contrib] SEAM: real tree-SHAP deferred (contributions not displayed in
    // v1). Return zeros of the right arity so the runner's arity check passes;
    // the runner drops the base term and filters display-excluded features itself.
    // NOTE: runner expects features-only length (no base term) -> return nFeatures.
    void features;
    return new Array(nFeatures).fill(0);
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
