/**
 * PhishGuard v3 — Module 3 (part 2): Fusion (fusion.js)
 *
 * Browser port of fusion.py (same control flow and seam guards, 1:1). Runs in
 * the offscreen document.
 *
 * fusion.js is the score choke-point: the router, the prior-shift, the
 * two-source alarm composition, and the assembly of the one verdict payload.
 *
 * Shipped scope: both heads are wired end-to-end through fuse. p_text is the
 * real TF-IDF text model (text_model.js), not a stub — DistilBERT was evaluated
 * and rejected, so there is no neural text head. The fusion weights w and w',
 * the per-head piCal and recalibrators, piDeploy, and the mapped cutoff are fit
 * and injected via FusionParams, not hardcoded. offscreen.js builds them from
 * artifacts/deploy_bundle.json at init, so this file never carries a number it
 * did not receive. That injection seam is the point: a refit artifact drops in
 * behind this same signature without touching the control flow here.
 *
 * Design notes (mirror the .py):
 *   - fusion params are injected, never hardcoded. piCal = 33.9% for both heads
 *     is the one pinned value, recorded as PI_CAL_BLUEPRINT and matched by the
 *     shipped bundle.
 *   - the router is one piece: both heads reachable and tested, and both w and
 *     w' are fit — w' fit independently on text-only rows.
 *   - rationale source: the host hands fuse the structured head's contribution
 *     list directly (offscreen.js); this file never withholds it. On a routed
 *     row that list is empty by construction and rule_fires[] carries the
 *     rationale instead. On the shipped build it is empty on a full row too,
 *     because the LightGBM model handle reports that it has no attribution to
 *     offer rather than inventing one — and since v1 ships
 *     VALIDATED_TRIGGERING_RULES = [], the displayed rationale is currently
 *     empty on every alarm. The channel is wired and tested ahead of its first
 *     real payload: landing real tree-SHAP in lightgbm_model.js fills it with
 *     no change here.
 */

'use strict';

const PI_CAL_BLUEPRINT = 0.339; // the pinned piCal, shared by both heads
const PI_DEPLOY_IS_ASSUMED = true; // piDeploy is assumed until validated; while assumed, any shown number is conditional

// ---- FusionParams construction + O-1 arity guard --------------------------
function makeHead(name, weights, piCal, recalibrator) {
  // recalibrator = { A, B }: the post-fusion 1-D sigmoid recalibration that
  // calibrates the fused score again. Fit per-head on the calibration fold and
  // shipped in deploy_bundle.json. Defaults to the identity recalibrator
  // {A:1, B:0}, so a caller that supplies none gets combine -> prior-shift
  // unchanged.
  const rc = recalibrator
    ? Object.freeze({ A: recalibrator.A, B: recalibrator.B })
    : Object.freeze({ A: 1.0, B: 0.0 });
  return Object.freeze({ name, weights: Object.freeze(weights.slice()), piCal, recalibrator: rc });
}

function makeFusionParams({ headFull, headTextOnly, piDeploy, mappedCutoff }) {
  // Arity guard at construction: a mis-shaped artifact fails at load, not at the
  // first live email. The differing arity (3 vs 2) is itself the shape-mismatch
  // check.
  if (headFull.weights.length !== 3) {
    throw new Error(
      `FusionParams: full head must have 3 weights (w0,w1,w2), got ${headFull.weights.length}`
    );
  }
  if (headTextOnly.weights.length !== 2) {
    throw new Error(
      `FusionParams: text-only head must have 2 weights (w0',w1'), got ${headTextOnly.weights.length}`
    );
  }
  return Object.freeze({ headFull, headTextOnly, piDeploy, mappedCutoff });
}

// ---- math -----------------------------------------------------------------
function _sigmoid(z) {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1.0 / (1.0 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1.0 + ez);
}

function _logit(p) {
  const eps = 1e-12;
  const q = Math.min(1.0 - eps, Math.max(eps, p));
  return Math.log(q / (1.0 - q));
}

// Apply a 1-D sigmoid recalibrator, sigmoid(A*logit(p)+B). Identity when
// {A:1,B:0}. Mirrors fusion_deploy.apply_text_calibrator / the fused
// recalibrator in train_fusion.
function applyCalibrator(p, A, B) {
  return _sigmoid(A * _logit(p) + B);
}

// The odds prior-shift correction, and the only place the shift happens. p_cal
// is calibrated at piCal; re-base to inbox prevalence piDeploy.
function priorShift(pCal, piDeploy, piCal) {
  const eps = 1e-12;
  const p = Math.min(1.0 - eps, Math.max(eps, pCal));
  const oddsCal = p / (1.0 - p);
  const oddsDep = oddsCal * (piDeploy / (1.0 - piDeploy)) * ((1.0 - piCal) / piCal);
  return oddsDep / (1.0 + oddsDep);
}

// ---- rationale composition (list in severity order, never merge) ------------
function composeRationale(leadSource, ruleFires, contributions, headName) {
  const signals = [];
  // Rules lead (deterministic fact > calibrated estimate).
  for (const rid of ruleFires) signals.push({ id: rid });
  // Contributions only on the full-fusion path; on a routed row they are [].
  if (headName === 'full') {
    for (const c of contributions) signals.push({ feature: c.feature, weight: c.value });
  }
  return signals;
}

// ---- fuse -----------------------------------------------------------------
function fuse(emailId, pText, pStruct, contributions, ruleFires, supportFlag, backend, params) {
   // Invariant: support_flag=true guarantees a non-null p_struct. If the two
  // producers of that fact disagree, logit(pStruct) below would deref null on a
  // live email. Fail loud, never mis-score.
  if (supportFlag && (pStruct === null || pStruct === undefined)) {
    throw new Error('fuse: support_flag=true with null p_struct (T-2 invariant)');
  }

  // The router lives here (next to the heads). Read support_flag, select.
  const head = supportFlag ? params.headFull : params.headTextOnly;

  // p_struct is ignored (not neutralized to 0.5) on the text-only branch; w' was
  // fit independently on text-only rows. pText/pStruct arrive already calibrated
  // per head (owned by the runners); fuse does the combine.
  let pFused;
  if (head.name === 'full') {
    const [w0, w1, w2] = head.weights;
    pFused = _sigmoid(w0 + w1 * _logit(pText) + w2 * _logit(pStruct));
  } else {
    const [w0p, w1p] = head.weights;
    pFused = _sigmoid(w0p + w1p * _logit(pText));
  }

  // The fused score is calibrated again, with the producing head's recalibrator.
  // Identity {A:1,B:0} for a head constructed without one.
  const pCal = applyCalibrator(pFused, head.recalibrator.A, head.recalibrator.B);

  // Prior-shift applied here with the producing head's piCal.
  const pDeployRaw = priorShift(pCal, params.piDeploy, head.piCal);

  // Two-source alarm composition, one banner.
  const ruleFired = ruleFires.length > 0;
  const probFired = pDeployRaw >= params.mappedCutoff; // Same operating point

  if (!ruleFired && !probFired) {
    // Silent, no number. Still echoes emailId + backend (matchable, provenance).
    return {
      emailId,
      fired: false,
      leadSource: null,
      producedBy: null,
      pDeploy: null,
      probIsConditional: false,
      signals: [],
      backend,
    };
  }

  const leadSource = ruleFired ? 'rule' : 'prob';

  // The number follows the reason: no number on a rule-only alarm.
  const pDeploy = probFired ? pDeployRaw : null;

  // Name a model only when a calibrated number was shown.
  let producedBy = null;
  if (leadSource === 'prob') producedBy = head.name === 'full' ? 'full' : 'text_only';

  const probIsConditional = pDeploy !== null && PI_DEPLOY_IS_ASSUMED;

  const signals = composeRationale(leadSource, ruleFires, contributions, head.name);

  return {
    emailId,
    fired: true,
    leadSource,
    producedBy,
    pDeploy,
    probIsConditional,
    signals,
    backend,
  };
}

// Dual-mode export: Node (CommonJS, for parity tests) and browser (global, for
// the offscreen document loaded via <script>). Neither path affects the other.
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node / parity harness
  } else {
    root.Fusion = api;               // browser: window.Fusion
  }
})(typeof self !== 'undefined' ? self : this, {
  PI_CAL_BLUEPRINT,
  PI_DEPLOY_IS_ASSUMED,
  makeHead,
  makeFusionParams,
  applyCalibrator,
  priorShift,
  composeRationale,
  fuse,
  _sigmoid,
  _logit,
});
