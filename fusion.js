/**
 * PhishGuard v3 --- Module 3 (part 2): Fusion, struct-only slice (fusion.js)
 *
 * Browser port of fusion.py (same control flow + seam guards, 1:1). Runs in the
 * OFFSCREEN document. Implementation Companion v1.6 (fusion.js module sketch +
 * fuse() listing); blueprint C-a/C-b/C-c/C-h/C-i/C-k + prior-shift; Addendum 2
 * O-1 (serialization) + O-7 (pi_deploy).
 *
 * fusion.js is the score choke-point: router (T-2), prior-shift (T-3), two-source
 * alarm composition (T-1/C-k), and the assembly of the ONE verdict payload.
 *
 * MILESTONE-3 SCOPE ("fusion (struct only)"): the LightGBM path wired end-to-end
 * through fuse with a p_text STUB (DistilBERT is Milestone 4). The fusion WEIGHTS
 * w, w', per-head piCal, piDeploy, and the mapped cutoff are Milestone-5 / O-7
 * artifacts and are INJECTED via FusionParams --- NOT hardcoded, because those
 * numbers are not yet fit and fabricating them is exactly what the project
 * forbids. This file ships the real control flow; Milestone 5 swaps in the
 * fitted artifact behind this fixed signature.
 *
 * SEAMS (mirror the .py):
 *   [FU-alpha] fusion params injected (unfit in M3). piCal=33.9% for BOTH heads
 *              is the one pinned value (C-h step 1), recorded as PI_CAL_BLUEPRINT.
 *   [FU-beta]  the router is one piece: both heads reachable + tested; M3 does not
 *              claim w' is FIT (that is M5).
 *   [FU-gamma] rationale source: contributions on a full row, rule_fires[] on a
 *              routed row (contributions are [] there by construction).
 */

'use strict';

const PI_CAL_BLUEPRINT = 0.339; // C-h step 1: both heads
const PI_DEPLOY_IS_ASSUMED = true; // O-7: assumed until R4 -> shown number is conditional

// ---- FusionParams construction + O-1 arity guard --------------------------
function makeHead(name, weights, piCal, recalibrator) {
  // recalibrator = { A, B }: the post-fusion 1-D sigmoid recalibration (C1 step 3,
  // "the fused score is calibrated again"). Fit per-head on the calibration fold
  // (Milestone 5). Defaults to identity {A:1, B:0} so an M3-era caller that has
  // not fit one yet gets the pre-M5 behavior (combine -> prior-shift) unchanged.
  const rc = recalibrator
    ? Object.freeze({ A: recalibrator.A, B: recalibrator.B })
    : Object.freeze({ A: 1.0, B: 0.0 });
  return Object.freeze({ name, weights: Object.freeze(weights.slice()), piCal, recalibrator: rc });
}

function makeFusionParams({ headFull, headTextOnly, piDeploy, mappedCutoff }) {
  // O-1 arity guard at construction: a mis-shaped artifact fails at load, not at
  // the first live email. Differing arity (3 vs 2) is the shape-mismatch feature.
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

// C1 step 3: apply a 1-D sigmoid recalibrator, sigmoid(A*logit(p)+B). Identity
// when {A:1,B:0}. Mirrors fusion_deploy.apply_text_calibrator / the fused
// recalibrator in train_fusion.
function applyCalibrator(p, A, B) {
  return _sigmoid(A * _logit(p) + B);
}

// C-h step 3: the odds prior-shift correction. The ONLY place the shift happens
// (T-3). p_cal is calibrated at piCal; re-base to inbox prevalence piDeploy.
function priorShift(pCal, piDeploy, piCal) {
  const eps = 1e-12;
  const p = Math.min(1.0 - eps, Math.max(eps, pCal));
  const oddsCal = p / (1.0 - p);
  const oddsDep = oddsCal * (piDeploy / (1.0 - piDeploy)) * ((1.0 - piCal) / piCal);
  return oddsDep / (1.0 + oddsDep);
}

// ---- rationale composition (C-i / C-k: list in severity order, never merge) --
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
  // T-2 invariant: support_flag=true GUARANTEES a non-null p_struct. If the two
  // producers of that fact disagree, logit(pStruct) below derefs null on a live
  // email. Fail loud (O-1), never mis-score.
  if (supportFlag && (pStruct === null || pStruct === undefined)) {
    throw new Error('fuse: support_flag=true with null p_struct (T-2 invariant)');
  }

  // T-2: the router lives here (next to the heads). Read support_flag, select.
  const head = supportFlag ? params.headFull : params.headTextOnly;

  // p_struct is IGNORED (not neutralized to 0.5) on the text-only branch; w' was
  // fit INDEPENDENTLY on text-only rows (O-1). pText/pStruct arrive ALREADY
  // calibrated per head (C1 step 1, owned by the runners); fuse does the combine.
  let pFused;
  if (head.name === 'full') {
    const [w0, w1, w2] = head.weights;
    pFused = _sigmoid(w0 + w1 * _logit(pText) + w2 * _logit(pStruct));
  } else {
    const [w0p, w1p] = head.weights;
    pFused = _sigmoid(w0p + w1p * _logit(pText));
  }

  // C1 step 3: the fused score is calibrated AGAIN, with the PRODUCING head's
  // recalibrator. Identity {A:1,B:0} for an M3-era head with none fit yet.
  const pCal = applyCalibrator(pFused, head.recalibrator.A, head.recalibrator.B);

  // T-3: prior-shift applied HERE with the PRODUCING head's piCal (C-h).
  const pDeployRaw = priorShift(pCal, params.piDeploy, head.piCal);

  // T-1 / C-k: two-source alarm composition, one banner.
  const ruleFired = ruleFires.length > 0;
  const probFired = pDeployRaw >= params.mappedCutoff; // C-h step 5: same operating point

  if (!ruleFired && !probFired) {
    // S1: silent, no number. Still echoes emailId + backend (matchable, provenance).
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

  // C-k / C-h step 5: the number follows the REASON. No number on a rule-only alarm.
  const pDeploy = probFired ? pDeployRaw : null;

  // C-i floor: name a MODEL only when a calibrated number was shown.
  let producedBy = null;
  if (leadSource === 'prob') producedBy = head.name === 'full' ? 'full' : 'text_only';

  const probIsConditional = pDeploy !== null && PI_DEPLOY_IS_ASSUMED; // O-7

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

// Dual-mode export: Node (CommonJS, for parity tests) AND browser (global, for
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
