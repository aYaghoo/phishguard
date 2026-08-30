/**
 * content_script.js  --  STEP 1 skeleton. Runs in the Gmail page context. Later
 * it owns the verdict cache (T-4/T-5), detects open emails, requests scores from
 * the worker, validates the returning Verdict (C-j/T-13), and drives verdict_ui.
 *
 * For now it does exactly one thing: prove it injected into Gmail. No DOM
 * reading, no scoring.
 */

'use strict';

console.log('[PhishGuard content] injected into Gmail page.');

// ---- STEP 2: readiness pull (kept) -------------------------------------
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

// ---- STEP 3: detect email opens and log the subject --------------------
// Gmail is an SPA: opening an email mutates the DOM (no navigation). So we watch
// for DOM changes with a MutationObserver, debounce, and re-probe. We log only
// when the OPEN email changes (by emailId), so we don't spam on every mutation.
const TAG = '[PhishGuard content]';
let lastEmailId = null;
let debounceTimer = null;
const DEBOUNCE_MS = 250; // simple debounce for step 3 (real T_d comes later)

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

    // STEP 5b: map the DOM node to the extractor's node shape and request a score.
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

// ---- STEP 5b: request a score for the open email -----------------------
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
      // STEP 6: render the verdict to a plan (pure logic, T-3) and apply it to
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
