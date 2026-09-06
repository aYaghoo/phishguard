/**
 * service_worker.js  --  the event router (it may die every ~30s and owns no
 * state, companion T-4). Two jobs, both shipped:
 *
 *   1. Ensure the offscreen document EXISTS, because the offscreen doc is what
 *      loads and validates the artifact bundle. Without the worker creating it,
 *      the offscreen document never boots. ensureOffscreen() runs once at load
 *      AND at the head of every routed message, so a worker that died and
 *      respawned re-creates the doc instead of routing into nothing.
 *   2. Route request/reply between the content script and the offscreen
 *      document (T-6): QUERY_READY and SCORE_EMAIL are forwarded under distinct
 *      *_OFFSCREEN types (so the worker cannot catch its own forward) and the
 *      replies are relayed back.
 *
 * The worker holds NO readiness state and caches nothing --- see the PURE ROUTER
 * note on the onMessage listener. C-j: messages are accepted only when they
 * carry this extension's own id.
 */

'use strict';

const OFFSCREEN_PATH = 'offscreen.html';

// Guard against the check-then-act race: two concurrent callers (init + a
// QUERY_READY arriving) can both see "no offscreen doc" and both try to create
// one, and the second throws "Only a single offscreen document may be created."
// We serialize on a single in-flight creation promise, and treat the
// already-exists error as success (idempotent).
let creatingPromise = null;

async function ensureOffscreen() {
  const TAG = '[PhishGuard worker]';
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) {
    return; // already up
  }
  // if a creation is already in flight, await THAT one instead of starting a second.
  if (creatingPromise) {
    return creatingPromise;
  }
  creatingPromise = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS'],
        justification: 'Runs local phishing-detection inference and holds the warm model + artifact set.',
      });
      console.log(`${TAG} offscreen document created.`);
    } catch (e) {
      // A concurrent creation won the race — that's fine, the doc now exists.
      if (/single offscreen document/i.test(e.message)) {
        console.log(`${TAG} offscreen already being created by a concurrent caller — OK.`);
      } else {
        throw e;
      }
    } finally {
      creatingPromise = null;
    }
  })();
  return creatingPromise;
}

// Create the offscreen doc when the worker starts (install or respawn).
chrome.runtime.onStartup.addListener(ensureOffscreen);
chrome.runtime.onInstalled.addListener(ensureOffscreen);

// T-6: the worker is a PURE ROUTER for request/reply — it holds no readiness
// state. A content-script QUERY_READY wakes the worker (MV3: a page-context
// sendMessage revives a dead worker), the worker ensures the offscreen doc
// exists, forwards the query to it, and relays the reply back. No caching.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const TAG = '[PhishGuard worker]';
  if (!msg || typeof msg !== 'object') return false;
  // C-j: only accept from our own extension.
  if (!sender || sender.id !== chrome.runtime.id) {
    return false;
  }

  if (msg.type === 'QUERY_READY') {
    console.log(`${TAG} routing QUERY_READY -> offscreen`);
    (async () => {
      try {
        await ensureOffscreen();
        const reply = await chrome.runtime.sendMessage({ type: 'QUERY_READY_OFFSCREEN' });
        sendResponse(reply);
      } catch (e) {
        console.error(`${TAG} QUERY_READY routing failed:`, e.message);
        sendResponse({ type: 'READY_STATE', ready: false, detail: `router error: ${e.message}` });
      }
    })();
    return true; // async response
  }

  if (msg.type === 'SCORE_EMAIL') {
    (async () => {
      try {
        await ensureOffscreen();
        // forward with a DISTINCT type so the worker does not catch its own forward.
        const reply = await chrome.runtime.sendMessage({
          type: 'SCORE_EMAIL_OFFSCREEN', node: msg.node,
        });
        sendResponse(reply);
      } catch (e) {
        console.error(`${TAG} SCORE_EMAIL routing failed:`, e.message);
        sendResponse({ type: 'SCORE_RESULT', ok: false, error: `router error: ${e.message}` });
      }
    })();
    return true; // async response
  }

  return false; // not ours
});

// Also attempt immediately, so loading the unpacked extension boots offscreen
// without waiting for a browser restart.
ensureOffscreen().catch((e) =>
  console.error('[PhishGuard worker] ensureOffscreen failed:', e.message)
);
