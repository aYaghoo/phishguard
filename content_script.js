/**
 * content_script.js — Gmail page-context script. Injects into Gmail, detects
 * the open email, round-trips it to the offscreen scorer through the worker,
 * and renders the returned verdict.
 *
 * Flow: query readiness from the offscreen document (via worker) → watch the
 * Gmail SPA with a debounced MutationObserver → probe the open message through
 * dom_adapter → map the DOM node to the extractor's shape → SCORE_EMAIL to the
 * worker, which forwards to offscreen → hand the verdict to verdict_ui, which
 * owns the display gate and writes the banner through a textContent-only sink.
 * This module computes no calibration math; it renders the finished verdict.
 *
 * Known limitations: no verdict cache (re-opening an email re-scores it;
 * `lastEmailId` guards against observer chatter, not a cache); the returned
 * verdict is trusted on `reply.ok` rather than schema-validated.
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
// Debounce: 250ms is a placeholder, not a tuned value. The intended design is a
// leading-edge lockout coordinated with a quiescence timer; this script
// currently implements only a trailing setTimeout, and neither interval has
// been measured.
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
