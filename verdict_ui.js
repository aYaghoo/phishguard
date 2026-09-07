/**
 * PhishGuard v3 --- Module 6 (part 1): Verdict UI + silent-until-flagged gating
 * (verdict_ui.js)
 *
 * Browser (page-context) port of verdict_ui.py, 1:1 with its render() /
 * clearBanner() / scanningOnly() and _mapSignals. The only module that renders
 * to the user.
 *
 * This module owns the display gate: the banner appears only when verdict.fired
 * (an alarm threshold crossed); below every threshold it is verdict-silent. The
 * passive "scanning" activity tier makes no safety claim, so it is consistent
 * with silent-until-flagged whether or not it shows.
 *
 * The .py returns a RenderPlan value object; the browser turns that plan into
 * textContent-only writes (never innerHTML). This port returns the same plan
 * object (so the parity harness can cross the two ports) and exposes an
 * applyPlan() that a real binding would call to write the DOM. The gating logic
 * — the part that matters — is identical to the .py.
 *
 * Computes no calibration math: no priorShift/logit/piCal here. The displayed
 * number is the finished pDeploy fuse() produced, and a test greps this file for
 * that math and asserts its absence. Staleness is passed in from the cache entry,
 * not derived. The scanning tier is gated on a coldRead boolean passed in, not a
 * measured warm-up constant.
 */

'use strict';

const PRIMARY_BANNER = 'banner';
const PRIMARY_SILENT = 'silent';

// --- The S1 gating decision (mirrors verdict_ui.py::render) -----------------
function render(verdict, stale, coldRead = false) {
  // The banner appears only at/above an alarm threshold. verdict.fired is that
  // crossing (prob or rule; fuse() already composed the two). Below every
  // threshold: verdict-silent. This module never previews a score (anti-flicker):
  // it only ever sees a finished verdict.
  if (!verdict.fired) {
    return {
      primary: PRIMARY_SILENT,
      scanningTier: coldRead, // activity signal only; S1 holds whether or not it shows
      showProbability: false,
      probability: null,
      conditionalCaveat: false,
      attributionKind: null,
      attributionLabel: null,
      rationale: [],
      staleIndicator: false,
      offerDismiss: false,
      backend: verdict.backend,
    };
  }

  // The banner fires. A banner is a claim, so the passive activity tier is not
  // shown alongside it. Attribution follows the alarm source.
  let attributionKind;
  let attributionLabel;
  let showProbability;
  if (verdict.leadSource === 'prob') {
    attributionKind = 'model';
    attributionLabel = verdict.producedBy; // "full" | "text_only"
    showProbability = verdict.pDeploy !== null && verdict.pDeploy !== undefined;
  } else {
    // rule-only alarm: no number, name the rule (produced_by is null). The
    // leading rule id is the first rationale signal fuse() emitted (rules lead).
    attributionKind = 'rule';
    const leadingRule = (verdict.signals.find((s) => s.id != null) || {}).id;
    attributionLabel = leadingRule != null ? leadingRule : null;
    showProbability = false;
  }

  // Conditional on the assumed pi_deploy until validated. fuse() already computed
  // probIsConditional; the UI reads it (no calibration reasoning here).
  const conditionalCaveat = showProbability && verdict.probIsConditional;

  return {
    primary: PRIMARY_BANNER,
    scanningTier: false, // a fired banner ends the wait
    showProbability,
    probability: showProbability ? verdict.pDeploy : null, // T-3: finished number, not recomputed
    conditionalCaveat,
    attributionKind,
    attributionLabel,
    rationale: mapSignals(verdict.signals),
    staleIndicator: stale,  // read from the cache entry, composed here
    offerDismiss: true, // a fired banner offers "not phishing"
    backend: verdict.backend, // carried for logging, never re-stamped
  };
}

function clearBanner() {
  return {
    primary: PRIMARY_SILENT,
    scanningTier: false,
    showProbability: false,
    probability: null,
    conditionalCaveat: false,
    attributionKind: null,
    attributionLabel: null,
    rationale: [],
    staleIndicator: false,
    offerDismiss: false,
    backend: null,
  };
}

function scanningOnly() {
  return {
    primary: PRIMARY_SILENT,
    scanningTier: true,
    showProbability: false,
    probability: null,
    conditionalCaveat: false,
    attributionKind: null,
    attributionLabel: null,
    rationale: [],
    staleIndicator: false,
    offerDismiss: false,
    backend: null,
  };
}

function mapSignals(signals) {
  // Preserve fuse()'s order (rules lead, listed not merged). Exactly one of
  // {id, feature} is set per signal.
  const lines = [];
  for (const s of signals) {
    if (s.id != null) {
      lines.push({ kind: 'rule', label: s.id, weight: null });
    } else if (s.feature != null) {
      lines.push({ kind: 'feature', label: s.feature, weight: s.weight != null ? s.weight : null });
    }
  }
  return lines;
}

// --- The DOM sink: textContent-only. A real binding calls this; the logic above
// is what the parity harness crosses. Kept tiny and dumb.
function applyPlan(plan, dom) {
  // dom is an injected object of textContent-only setters. No innerHTML anywhere.
  // This is browser glue, not logic; it is not crossed in parity.
  if (!dom) return;
  if (plan.primary === PRIMARY_BANNER) {
    dom.setBannerVisible(true);
    dom.setBannerText(
      plan.attributionKind === 'model'
        ? `Flagged by the ${plan.attributionLabel} model`
        : `Flagged by rule: ${plan.attributionLabel}`
    );
    if (plan.showProbability) dom.setProbabilityText(String(plan.probability));
    else dom.clearProbability();
    dom.setCaveatVisible(plan.conditionalCaveat);
    dom.setStaleVisible(plan.staleIndicator);
    dom.setRationale(plan.rationale.map((l) => l.label)); // textContent list
    dom.setDismissVisible(plan.offerDismiss);
  } else {
    dom.setBannerVisible(false);
  }
  dom.setScanningVisible(plan.scanningTier);
}

(function(){
const __api = {
  PRIMARY_BANNER,
  PRIMARY_SILENT,
  render,
  clearBanner,
  scanningOnly,
  mapSignals,
  applyPlan,
};

// dual-mode export (Node CommonJS for parity + browser global for content script)
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VerdictUI = api;
  }
})(typeof self !== 'undefined' ? self : this, __api);
})();
