/**
 * artifact_loader.js  --  the T-10 / O-1 artifact-set coherence validator.
 *
 * ONE owner (offscreen document) validates the WHOLE artifact set at init and
 * REFUSES TO LOAD a mismatch rather than mis-scoring (O-1: "refuses to load
 * rather than mis-scoring"). Not five scattered per-runner checks -- one place
 * that answers "is this artifact set coherent."
 *
 * PORT-SPLIT: the coherence rules are contract logic (Python validate_bundle in
 * fusion_deploy.py is the mutation-tested owner); this JS is the deployed port,
 * proven identical by parity_artifact_loader.cjs. Same discipline as fusion.js.
 *
 * WHAT IT CHECKS (T-10, O-1, C-h step 1):
 *   - schema_version matches the runtime's expected version (a stale/foreign
 *     bundle is refused, not best-effort loaded);
 *   - each head carries its O-1 pi_cal stamp (the number the prior-shift needs);
 *   - both heads share the SAME pi_cal (C-h step 1: same calibration base rate --
 *     a routed row and a full row must be prior-shifted from the same prior);
 *   - the full head has arity-3 weights, the text-only head arity-2 (O-1: "distinct
 *     keys with arity"); a mis-shaped head is the shape-mismatch tripwire;
 *   - each head has a recalibrator {A,B} (C1 step 3);
 *   - pi_dep in (0,1), mapped_cutoff in [0,1];
 *   - the base-model provenance hashes, IF present, are internally consistent:
 *     the text head's fit references the SAME text_calibrator the bundle ships
 *     (O-1's "w' matches the temperature-scaler it was fit against"). Absent
 *     hashes are allowed (v1 may not stamp them yet) but a PRESENT-and-MISMATCHED
 *     hash is a hard refusal.
 *
 * Returns [] when coherent; a non-empty list of problem strings otherwise. The
 * caller (offscreen init) refuses to proceed if the list is non-empty.
 */

'use strict';

const SCHEMA_VERSION = 'phishguard-fusion-1';

function validateBundle(bundle) {
  // Returns an array of { code, msg }. `code` is the stable contract identifier
  // (parity is checked on codes, immune to number/quote formatting differences
  // between JS and Python); `msg` is human diagnostic text.
  const problems = [];
  const add = (code, msg) => problems.push({ code, msg });

  if (!bundle || typeof bundle !== 'object') {
    add('BUNDLE_MISSING', 'bundle is missing or not an object');
    return problems;
  }

  if (bundle.schema_version !== SCHEMA_VERSION) {
    add('SCHEMA_MISMATCH',
      `schema_version mismatch: ${JSON.stringify(bundle.schema_version)} != ${JSON.stringify(SCHEMA_VERSION)}`);
  }

  const heads = bundle.heads || {};
  for (const name of ['full', 'text_only']) {
    if (!(name in heads)) {
      add(`MISSING_HEAD_${name}`, `missing head '${name}'`);
      continue;
    }
    const h = heads[name];
    if (h.pi_cal === undefined || h.pi_cal === null) {
      add(`NO_PICAL_${name}`, `head '${name}' missing O-1 pi_cal stamp`);
    }
    if (!h.recalibrator || typeof h.recalibrator.A !== 'number' || typeof h.recalibrator.B !== 'number') {
      add(`NO_RECAL_${name}`, `head '${name}' missing recalibrator {A,B} (C1 step 3)`);
    }
  }

  if (heads.full && heads.full.w) {
    const w = heads.full.w;
    if (!(typeof w.w0 === 'number' && typeof w.w1 === 'number' && typeof w.w2 === 'number')) {
      add('FULL_ARITY', 'full head weights must be {w0,w1,w2} (arity 3)');
    }
  } else if (heads.full) {
    add('FULL_NO_W', "full head missing 'w' weights");
  }
  if (heads.text_only && heads.text_only.w_prime) {
    const wp = heads.text_only.w_prime;
    if (!(typeof wp.w0p === 'number' && typeof wp.w1p === 'number')) {
      add('TEXTONLY_ARITY', "text_only head weights must be {w0p,w1p} (arity 2)");
    }
  } else if (heads.text_only) {
    add('TEXTONLY_NO_W', "text_only head missing 'w_prime' weights");
  }

  if (heads.full && heads.text_only &&
      heads.full.pi_cal !== undefined && heads.text_only.pi_cal !== undefined &&
      heads.full.pi_cal !== heads.text_only.pi_cal) {
    add('PICAL_DISAGREE',
      `heads disagree on pi_cal (C-h step 1): full=${heads.full.pi_cal} text_only=${heads.text_only.pi_cal}`);
  }

  if (!(typeof bundle.pi_dep === 'number' && bundle.pi_dep > 0 && bundle.pi_dep < 1)) {
    add('PIDEP_RANGE', `pi_dep out of range (0,1): ${bundle.pi_dep}`);
  }
  if (!(typeof bundle.mapped_cutoff === 'number' && bundle.mapped_cutoff >= 0 && bundle.mapped_cutoff <= 1)) {
    add('CUTOFF_RANGE', `mapped_cutoff out of [0,1]: ${bundle.mapped_cutoff}`);
  }

  if (!bundle.text_calibrator ||
      typeof bundle.text_calibrator.A !== 'number' ||
      typeof bundle.text_calibrator.B !== 'number') {
    add('NO_TEXT_CAL', 'missing text_calibrator {A,B}');
  }

  if (bundle.text_calibrator && bundle.text_calibrator.hash !== undefined) {
    const shipped = bundle.text_calibrator.hash;
    for (const name of ['full', 'text_only']) {
      const h = heads[name];
      if (h && h.fit_against_calibrator_hash !== undefined &&
          h.fit_against_calibrator_hash !== shipped) {
        add(`HASH_MISMATCH_${name}`,
          `head '${name}' fit against ${h.fit_against_calibrator_hash} but bundle ships ${shipped} (O-1)`);
      }
    }
  }

  return problems;
}

/**
 * The load gate: validate, and THROW if incoherent (O-1 "refuse rather than
 * mis-score"). The offscreen init calls this; a throw prevents the extension
 * from ever scoring with a mismatched artifact set.
 */
function loadBundleOrRefuse(bundle) {
  const problems = validateBundle(bundle);
  if (problems.length > 0) {
    throw new Error(
      'artifact-loader: refusing to load an incoherent bundle (O-1/T-10):\n  - ' +
      problems.map((p) => `[${p.code}] ${p.msg}`).join('\n  - ')
    );
  }
  return bundle;
}

// Dual-mode export: Node (CommonJS, for parity tests) AND browser (global, for
// the offscreen document loaded via <script>). Neither path affects the other.
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node / parity harness
  } else {
    root.ArtifactLoader = api;       // browser: window.ArtifactLoader
  }
})(typeof self !== 'undefined' ? self : this,
   { SCHEMA_VERSION, validateBundle, loadBundleOrRefuse });
