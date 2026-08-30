/**
 * PhishGuard v3 --- Module 6 (part 1): Verdict UI + S1 gating (verdict_ui.js)
 *
 * Browser (page-context) port of verdict_ui.py, 1:1 with its render() /
 * clearBanner() / scanningOnly() and _mapSignals. Implementation Companion v1.6,
 * module roster "verdict_ui.js --- the only module that renders to the user";
 * blueprint sec.ui (S1 "silent until flagged"), sec.budget passive tier (O-2),
 * Contracts C-i/C-k/O-7.
 *
 * This module owns the S1 GATE: the banner appears ONLY when verdict.fired
 * (an alarm threshold crossed); below every threshold it is verdict-silent. The
 * passive "scanning" activity tier makes NO safety claim, so it is consistent
 * with S1 whether or not it shows (blueprint sec.ui decisionbox).
 *
 * The .py returns a RenderPlan value object [UI-plan]; the browser turns that
 * plan into textContent-only writes (R9: never innerHTML). This port returns the
 * SAME plan object (so the parity harness can cross the two ports) and exposes an
 * applyPlan() that a real binding would call to write the DOM. The GATING LOGIC
 * --- the part that matters --- is identical to the .py.
 *
 * Computes NO calibration math (T-3): no priorShift/logit/piCal here. The
 * displayed number is the finished pDeploy fuse() produced. A test greps this
 * file for that math and asserts its absence. Staleness (T-5) is PASSED IN from
 * the cache entry, not derived. [UI-warm] the scanning tier is gated on a
 * coldRead boolean passed in, not a T_warm constant (a Milestone-4/7
 * measurement).
 */

'use strict';

const PRIMARY_BANNER = 'banner';
const PRIMARY_SILENT = 'silent';

// --- The S1 gating decision (mirrors verdict_ui.py::render) -----------------
function render(verdict, stale, coldRead = false) {
  // S1: the banner appears ONLY at/above an alarm threshold. verdict.fired IS
  // that crossing (prob OR rule; fuse() already composed the two, C-k). Below
  // every threshold: verdict-silent. This module NEVER previews a score
  // (anti-flicker): it only ever sees a FINISHED verdict.
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

  // The banner fires. A banner is a CLAIM, so the passive activity tier is NOT
  // shown alongside it. C-i/C-k step 5: attribution follows the alarm SOURCE.
  let attributionKind;
  let attributionLabel;
  let showProbability;
  if (verdict.leadSource === 'prob') {
    attributionKind = 'model';
    attributionLabel = verdict.producedBy; // "full" | "text_only"
    showProbability = verdict.pDeploy !== null && verdict.pDeploy !== undefined;
  } else {
    // rule-only alarm: NO number, name the RULE (produced_by is null). The
    // leading rule id is the first rationale signal fuse() emitted (rules lead).
    attributionKind = 'rule';
    const leadingRule = (verdict.signals.find((s) => s.id != null) || {}).id;
    attributionLabel = leadingRule != null ? leadingRule : null;
    showProbability = false;
  }

  // O-7: conditional on the ASSUMED pi_deploy until R4. fuse() already computed
  // probIsConditional; the UI READS it (T-3: no calibration reasoning here).
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
    staleIndicator: stale, // T-5: read from the cache entry, composed here
    offerDismiss: true, // T-11: a fired banner offers "not phishing"
    backend: verdict.backend, // T-8: carried for logging, never re-stamped
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
  // Preserve fuse()'s order (C-k: rules lead, listed not merged). Exactly one of
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

// --- The DOM sink [UI-plan]: textContent-only (R9). A real binding calls this;
// the LOGIC above is what the parity harness crosses. Kept tiny and dumb.
function applyPlan(plan, dom) {
  // dom is an injected object of textContent-only setters. No innerHTML anywhere
  // (R9). This is browser glue, not logic; it is not crossed in parity.
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
