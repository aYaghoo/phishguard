/**
 * content_script.js  --  the Gmail page-context script. Injects into Gmail,
 * detects which email is open, round-trips it to the offscreen scorer through
 * the worker, and renders the returned verdict.
 *
 * SHIPPED FLOW: pull readiness from the offscreen document via the worker
 * (QUERY_READY, T-6) -> watch the Gmail SPA with a MutationObserver, debounced
 * -> probe the open message through dom_adapter (window.PhishGuardDom) -> map
 * that DOM node to the extractor's node shape -> SCORE_EMAIL to the worker,
 * which forwards it to the offscreen document -> log the verdict and hand it to
 * verdict_ui (window.VerdictUI), which owns the S1 gate and writes the banner
 * through the textContent-only sink (R9). This module computes NO calibration
 * math (T-3): it renders the finished verdict, it never recomputes one.
 *
 * OPEN SEAMS --- named here because this is the module that is SUPPOSED to own
 * them and does not yet. Do not read the flow above as covering them:
 *   [CS-cache] there is NO verdict cache (T-4/T-5). Re-opening the same email
 *              re-scores it. `lastEmailId` is a dedup guard against
 *              MutationObserver chatter, NOT a cache: there is no settle
 *              counter, no dismiss flag (T-11), and `stale` is passed to
 *              verdict_ui hardcoded false.
 *   [CS-valid] the returning Verdict is NOT validated (C-j/T-13). `reply.ok` is
 *              the only check before the payload is read and rendered.
 *
 * ARCHITECTURAL NOTE (open, not settled here): ~/dev/phishing_project carries a
 * DIFFERENT module under this same filename --- the Node-testable orchestrator
 * port of content_script.py, which DOES own the cache, the settle counter and
 * the reply classifier. Which of the two is canonical is an open question. This
 * header describes only what THIS deployed file does; it does not decide that.
 */

'use strict';

console.log('[PhishGuard content] injected into Gmail page.');

// ---- readiness pull (T-6): the UI PULLS, the offscreen doc never pushes --
async function queryReady() {
  const TAG = '[PhishGuard content]';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'QUERY_READY' });
    if (reply && reply.type === 'READY_STATE') {
      console.log(
        `${TAG} round-trip OK — offscreen ready=${reply.ready}` +
        (reply.detail ? ` (${reply.detail})` : '')
      );
    } else {
      console.warn(`${TAG} unexpected reply shape:`, reply);
    }
  } catch (e) {
    console.error(`${TAG} queryReady failed:`, e.message);
  }
}
queryReady();

// ---- detect email opens and log the parsed node ------------------------
// Gmail is an SPA: opening an email mutates the DOM (no navigation). So we watch
// for DOM changes with a MutationObserver, debounce, and re-probe. We log only
// when the OPEN email changes (by emailId), so we don't spam on every mutation.
const TAG = '[PhishGuard content]';
let lastEmailId = null;
let debounceTimer = null;
// [CS-debounce] OPEN SEAM: 250ms is a PLACEHOLDER, not the designed T_d.
// The real debounce (dom_adapter.py) is a leading-edge lockout of T_d with an
// enforced T_d < T_q invariant against a quiescence timer (O-4, C-e/A-5).
// Neither T_d nor T_q has been measured, and this script has no quiescence
// timer at all --- just this trailing setTimeout. Do not read 250 as fit.
const DEBOUNCE_MS = 250;

function onMaybeChanged() {
  if (!window.PhishGuardDom) {
    console.warn(`${TAG} dom_adapter not loaded — check manifest script order`);
    return;
  }
  const probe = window.PhishGuardDom.probeOpenEmail();
  if (!probe.open) {
    // returned to list view (or nothing open): reset so re-opening logs again.
    if (lastEmailId !== null) {
      console.log(`${TAG} email closed (back to list/none).`);
      lastEmailId = null;
    }
    return;
  }
  if (probe.emailId !== lastEmailId) {
    lastEmailId = probe.emailId;
    const node = window.PhishGuardDom.probeEmailNode();
    console.log(`${TAG} email OPEN — id=${node.emailId}`);
    console.log(`${TAG}   subject: ${node.subject === null ? '(NOT FOUND)' : JSON.stringify(node.subject)}`);
    console.log(`${TAG}   sender : display=${JSON.stringify(node.sender.display)} address=${JSON.stringify(node.sender.address)}`);
    const bodyPreview = node.body === null ? '(NOT FOUND)'
      : JSON.stringify(node.body.slice(0, 120) + (node.body.length > 120 ? '…' : ''));
    console.log(`${TAG}   body   : ${node.body === null ? '(NOT FOUND)' : `${node.body.length} chars, via ${node.bodySelector}`}  preview=${bodyPreview}`);
    console.log(`${TAG}   urls   : ${node.urls.length} found`, node.urls.slice(0, 5));

    // map the DOM node to the extractor's node shape and request a score.
    scoreEmail(node);
  }
}

function scheduleProbe() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(onMaybeChanged, DEBOUNCE_MS);
}

const observer = new MutationObserver(scheduleProbe);
observer.observe(document.body, { childList: true, subtree: true });

// also probe once now, in case an email is already open at injection time.
scheduleProbe();

// ---- request a score for the open email --------------------------------
// Map the dom_adapter node -> the extractor's node shape, send to the offscreen
// document (via the worker), and log the returned verdict. The offscreen doc does
// the scoring; the content script never computes calibration (T-3).
async function scoreEmail(domNode) {
  // field mapping: dom_adapter {subject, sender:{display,address}, body, urls}
  //             -> extractor  {emailId, subject, body, senderDisplay, senderDomain, urls}
  const addr = (domNode.sender && domNode.sender.address) || '';
  const at = addr.lastIndexOf('@');
  const senderDomain = at !== -1 ? addr.slice(at + 1).toLowerCase() : '';
  const node = {
    emailId: domNode.emailId,
    subject: domNode.subject || '',
    body: domNode.body || '',
    senderDisplay: (domNode.sender && domNode.sender.display) || '',
    senderDomain,
    urls: domNode.urls || [],
  };
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'SCORE_EMAIL', node });
    if (reply && reply.ok) {
      const v = reply.verdict;
      console.log(
        `${TAG} ★ VERDICT id=${v.emailId} fired=${v.fired} ` +
        `p_deploy=${v.pDeploy === null ? 'null' : v.pDeploy.toFixed(4)} ` +
        `lead=${v.leadSource} producedBy=${v.producedBy}`
      );
      // render the verdict to a plan (pure logic, T-3) and apply it to
      // the Gmail DOM through the textContent-only sink (R9). The UI NEVER
      // recomputes — it renders the finished verdict.
      try {
        const plan = window.VerdictUI.render(v, /*stale=*/false, /*coldRead=*/false);
        window.VerdictUI.applyPlan(plan, window.PhishGuardDom.bannerDom);
      } catch (e) {
        console.error(`${TAG} banner render failed:`, e.message);
      }
    } else {
      console.warn(`${TAG} score failed:`, reply && reply.error);
    }
  } catch (e) {
    console.error(`${TAG} scoreEmail error:`, e.message);
  }
}
