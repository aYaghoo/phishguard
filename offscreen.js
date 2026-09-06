/**
 * offscreen.js  --  hosts the scorer. Boots the offscreen document, passes the
 * artifact gate on the real bundle, assembles the scoring chain, and answers
 * score requests routed from the worker.
 *
 * The offscreen document is the durable non-DOM context (companion T-4/T-6). At
 * init it is the artifact-loader owner (T-10): it loads the whole artifact set
 * and REFUSES to proceed if incoherent (O-1), rather than each runner checking
 * its own asset.
 *
 * SHIPPED CHAIN: fetch deploy_bundle.json -> loadBundleOrRefuse (T-10/O-1) ->
 * fetch lightgbm_model.json + text_model.json -> assembleScorer() builds the
 * StructModel, the TF-IDF TextModel and the two fusion heads from the bundle;
 * then per email: extract -> text head (+ struct head when support_flag) ->
 * fuse(). This document has NO DOM --- it receives already-parsed fields from
 * the content script and never reads Gmail itself.
 *
 * OPEN SEAM (do not read the above as covering it): there is still NO inbound
 * ScoreMsg shape validator (C-j/T-13). msg.node is handed to the scorer as
 * received; the only check standing between Gmail and this handler is the
 * extension-id test in service_worker.js. Readiness stayed a PULL (T-6) --- the
 * page-context UI queries through the worker; the push named in the original
 * plan was never built, and the pull is the shipped design, not a placeholder.
 */

'use strict';

// T-6: the offscreen document OWNS the `ready` flag (it is the only context that
// knows the model + artifacts are resident). The page-context UI PULLS this on
// demand through the worker; we never push it. `ready` flips true only after the
// artifact gate passes below.
let READY = false;
let READY_DETAIL = null; // small human-readable summary for logging/inspection
let SCORER = null;       // assembled scoring function (node -> verdict), set at init

// T-6 / C-j: answer readiness queries AND score requests routed from the worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const TAG = '[PhishGuard offscreen]';
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'QUERY_READY_OFFSCREEN') {
    console.log(`${TAG} QUERY_READY_OFFSCREEN received -> replying ready=${READY}`);
    sendResponse({ type: 'READY_STATE', ready: READY, detail: READY_DETAIL });
    return false;
  }

  if (msg.type === 'SCORE_EMAIL_OFFSCREEN') {
    // score a single email node (already DOM-parsed + field-mapped by the content
    // script). The offscreen doc has NO DOM; it receives fields, never reads Gmail.
    if (!READY || !SCORER) {
      sendResponse({ type: 'SCORE_RESULT', ok: false, error: 'not ready' });
      return false;
    }
    try {
      const verdict = SCORER(msg.node);
      console.log(`${TAG} scored ${msg.node && msg.node.emailId}: ` +
        `fired=${verdict.fired} p_deploy=${verdict.pDeploy === null ? 'null' : verdict.pDeploy.toFixed(4)}`);
      sendResponse({ type: 'SCORE_RESULT', ok: true, verdict });
    } catch (e) {
      console.error(`${TAG} scoring failed:`, e.message);
      sendResponse({ type: 'SCORE_RESULT', ok: false, error: e.message });
    }
    return false;
  }

  return false; // not ours
});

// ---- assemble the scorer from artifacts (the verified buildScorer chain) -----
function assembleScorer(bundle, lgbModelJson, textModelJson) {
  const structModel = LightGBMModel.makeStructModel(lgbModelJson);
  const textModel = TextModel.makeTextModel(textModelJson);

  const headFull = Fusion.makeHead('full',
    [bundle.heads.full.w.w0, bundle.heads.full.w.w1, bundle.heads.full.w.w2],
    bundle.heads.full.pi_cal, bundle.heads.full.recalibrator);
  const headTextOnly = Fusion.makeHead('text_only',
    [bundle.heads.text_only.w_prime.w0p, bundle.heads.text_only.w_prime.w1p],
    bundle.heads.text_only.pi_cal, bundle.heads.text_only.recalibrator);
  const params = Fusion.makeFusionParams({
    headFull, headTextOnly, piDeploy: bundle.pi_dep, mappedCutoff: bundle.mapped_cutoff,
  });
  const tcA = bundle.text_calibrator.A, tcB = bundle.text_calibrator.B;

  return function score(node) {
    const ex = FeatureExtractor.extract(node, FeatureExtractor.EMPTY_BRAND_MAP);
    const pTextRaw = textModel.scoreText(ex.text);
    const pTextCal = Fusion.applyCalibrator(pTextRaw, tcA, tcB);
    let pStructCal = null;
    if (ex.support_flag) {
      pStructCal = LightGBMRunner.scoreStruct(structModel, ex.features).pStruct;
    }
    return Fusion.fuse(node.emailId || 'email', pTextCal, pStructCal, [],
      ex.rule_fires, ex.support_flag, 'js', params);
  };
}

(async function init() {
  const TAG = '[PhishGuard offscreen]';
  try {
    // The bundle ships inside the extension; fetch it via the extension URL.
    const url = chrome.runtime.getURL('artifacts/deploy_bundle.json');
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`could not fetch deploy_bundle.json (HTTP ${resp.status})`);
    }
    const bundle = await resp.json();

    // T-10 / O-1: validate the artifact set; refuse to proceed if incoherent.
    // ArtifactLoader is the browser global exposed by artifact_loader.js.
    ArtifactLoader.loadBundleOrRefuse(bundle);

    // load the two model artifacts (LightGBM tree JSON + TF-IDF text model JSON).
    const [lgbResp, txtResp] = await Promise.all([
      fetch(chrome.runtime.getURL('artifacts/lightgbm_model.json')),
      fetch(chrome.runtime.getURL('artifacts/text_model.json')),
    ]);
    if (!lgbResp.ok) throw new Error(`lightgbm_model.json HTTP ${lgbResp.status}`);
    if (!txtResp.ok) throw new Error(`text_model.json HTTP ${txtResp.status}`);
    const lgbModelJson = await lgbResp.json();
    const textModelJson = await txtResp.json();

    // assemble the verified scoring chain (extract -> heads -> fuse).
    SCORER = assembleScorer(bundle, lgbModelJson, textModelJson);

    // If we got here, all artifacts loaded and the scorer is built.
    READY = true;
    READY_DETAIL = `schema=${bundle.schema_version} pi_dep=${bundle.pi_dep} cutoff=${bundle.mapped_cutoff}`;
    console.log(
      `${TAG} ready — bundle coherent, models loaded, scorer assembled. ` +
      `pi_dep=${bundle.pi_dep} cutoff=${bundle.mapped_cutoff} ` +
      `|vocab|=${textModelJson.vocab_terms.length} trees=${lgbModelJson.trees.length}`
    );
  } catch (err) {
    // O-1 fail-loud: a refusal or load error is LOUD, never a silent bad state.
    console.error(`${TAG} INIT FAILED:`, err.message);
  }
})();
