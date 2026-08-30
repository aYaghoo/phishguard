/**
 * dom_adapter.js  --  the ONLY module that touches Gmail's DOM (companion roster;
 * Layer-2 containment: all selectors behind one file, so a Gmail change is a
 * one-file fix). Runs in the page (content-script) context.
 *
 * SELECTOR HIERARCHY (companion): ARIA / data-* over structural over class.
 * Gmail's class names are auto-generated and volatile; data-* attributes and
 * ARIA roles are far more stable. We prefer them and fall back down the chain.
 *
 * STEP-3 SCOPE: the smallest useful read -- detect that an email is OPEN and read
 * its emailId (data-legacy-message-id, O-5) + subject. NOT the body, sender, or
 * URLs yet (those are the next increments), and NOT the quiescence/debounce
 * timers or the canary (later). One field at a time so a selector break is
 * localizable.
 *
 * On total failure every locate returns NO node (R1): the caller does nothing
 * rather than mis-reading. No throw on a missing selector -- a missing email is
 * a normal state (inbox list view), not an error.
 */

'use strict';

(function () {
  const TAG = '[PhishGuard dom]';

  // ---- emailId (O-5): the stable identity anchor -------------------------
  // data-legacy-message-id is Gmail's durable per-message id. The open message
  // container carries it. This is the blueprint's named hook (readEmailId).
  function findOpenMessageNode() {
    // Preferred: the open message view carries data-legacy-message-id. In the
    // conversation view there may be several; the LAST expanded one is the one
    // in focus. We take the last present as a first approximation (step 3).
    const withId = document.querySelectorAll('[data-legacy-message-id]');
    if (withId.length > 0) {
      return withId[withId.length - 1];
    }
    return null; // no open message (e.g. inbox list view) -- normal, not an error
  }

  function readEmailId(node) {
    if (!node) return null;
    return node.getAttribute('data-legacy-message-id') || null;
  }

  // ---- subject -----------------------------------------------------------
  // Hierarchy: prefer a data-*/ARIA hook; fall back to Gmail's subject class
  // (.hP is the long-standing subject heading class) as a last resort.
  function readSubject() {
    // 1) ARIA/structural: the subject is rendered as an <h2> heading in the
    //    open-message region on most Gmail layouts.
    const h2 = document.querySelector('h2[data-thread-perm-id], h2.hP');
    if (h2 && h2.textContent && h2.textContent.trim()) {
      return h2.textContent.trim();
    }
    // 2) class fallback (volatile): .hP is Gmail's subject line.
    const hp = document.querySelector('.hP');
    if (hp && hp.textContent && hp.textContent.trim()) {
      return hp.textContent.trim();
    }
    return null; // subject not found -- report null, do not guess
  }

  // ---- body (the blueprint's designed selector chain; confirming live) ---
  // ORDER is the settled contract (ARIA -> data-* -> structural -> class); the
  // STRINGS are the ones the blueprint flagged "CONFIRM ON LIVE GMAIL". Gmail's
  // message body is div.a3s; we anchor it under progressively-less-stable parents.
  const BODY_SELECTORS = [
    'div[role="listitem"] div.a3s', // ARIA role anchor + body class (preferred)
    'div[data-message-id] div.a3s', // data-* anchor
    'div.adn div.a3s',              // structural relationship
    'div.a3s',                      // class-only, last resort
  ];

  function locateBodyNode() {
    for (const sel of BODY_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) {
        // conversation view can have several; the last is the focused/open one.
        return { node: nodes[nodes.length - 1], selector: sel };
      }
    }
    return { node: null, selector: null }; // total failure -> no node (R1)
  }

  function readBody() {
    const { node, selector } = locateBodyNode();
    if (!node) return { text: null, selector: null };
    // innerText approximates the rendered, visible text (collapses hidden nodes,
    // respects line breaks) better than textContent for a phishing-body read.
    const text = (node.innerText || node.textContent || '').trim();
    return { text: text || null, selector };
  }

  // ---- sender (display name + address; parse mirrors parse_sender) --------
  // Gmail renders the sender in a span carrying the address in an attribute.
  // Hierarchy: the .gD / span[email] attribute (stable-ish data hook) over the
  // visible display-name text.
  function readSender() {
    // span[email="..."] is Gmail's long-standing sender hook; .gD is its class.
    const el = document.querySelector('span[email], .gD[email], .gD');
    if (!el) return { display: null, address: null };
    const address = el.getAttribute('email') || null;   // the actual address
    const display = (el.getAttribute('name') || el.textContent || '').trim() || null;
    return { display, address };
  }

  // ---- URLs (from the body node only; not the whole page) ----------------
  // Extract hrefs from anchors WITHIN the located body, so we read the email's
  // links, not Gmail's chrome. Returns unique hrefs.
  function readUrls() {
    const { node } = locateBodyNode();
    if (!node) return [];
    const anchors = node.querySelectorAll('a[href]');
    const seen = new Set();
    for (const a of anchors) {
      const href = a.getAttribute('href');
      if (href && /^https?:/i.test(href)) seen.add(href);
    }
    return [...seen];
  }

  // ---- verdict banner DOM sink [UI-plan / R9] ---------------------------
  // The banner element is created ONCE and reused. All setters touch ONLY
  // textContent / hidden / style — NEVER innerHTML (R9 anti-XSS). This is the
  // 'dom' object verdict_ui.applyPlan writes through; it is dumb glue, no logic.
  let bannerEl = null;
  let bannerParts = null;

  function buildBanner() {
    // structure, built with safe DOM APIs (no innerHTML). One banner, reused.
    const root = document.createElement('div');
    root.setAttribute('data-phishguard-banner', '1');
    root.style.cssText = [
      'margin:8px 0', 'padding:12px 16px', 'border-radius:8px',
      'border:1px solid #d93025', 'background:#fce8e6', 'color:#5f1310',
      'font-family:Roboto,Arial,sans-serif', 'font-size:14px', 'line-height:1.4',
      'box-shadow:0 1px 3px rgba(0,0,0,0.12)', 'display:none',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;display:flex;align-items:center;gap:8px';
    const icon = document.createElement('span');
    icon.textContent = '\u26A0'; // warning sign, textContent (not innerHTML)
    const titleText = document.createElement('span');
    titleText.textContent = 'Possible phishing';
    title.appendChild(icon);
    title.appendChild(titleText);

    const attribution = document.createElement('div');
    attribution.style.cssText = 'margin-top:4px';

    const probability = document.createElement('div');
    probability.style.cssText = 'margin-top:2px;font-variant-numeric:tabular-nums';

    const caveat = document.createElement('div');
    caveat.style.cssText = 'margin-top:4px;font-size:12px;color:#7a2118;display:none';
    caveat.textContent = 'Score assumes an estimated phishing rate; treat as provisional.';

    const stale = document.createElement('div');
    stale.style.cssText = 'margin-top:4px;font-size:12px;color:#7a2118;display:none';
    stale.textContent = 'This verdict may be out of date.';

    const rationale = document.createElement('ul');
    rationale.style.cssText = 'margin:6px 0 0;padding-left:18px;font-size:12px';

    const dismiss = document.createElement('button');
    dismiss.textContent = 'Not phishing';
    dismiss.style.cssText = [
      'margin-top:8px', 'padding:4px 10px', 'border:1px solid #d93025',
      'border-radius:4px', 'background:#fff', 'color:#5f1310', 'cursor:pointer',
      'font-size:12px', 'display:none',
    ].join(';');
    dismiss.addEventListener('click', () => { root.style.display = 'none'; });

    root.appendChild(title);
    root.appendChild(attribution);
    root.appendChild(probability);
    root.appendChild(caveat);
    root.appendChild(stale);
    root.appendChild(rationale);
    root.appendChild(dismiss);

    bannerParts = { root, attribution, probability, caveat, stale, rationale, dismiss };
    return root;
  }

  function ensureBannerPlaced() {
    // (re)create the element if missing, and place it just above the body node.
    if (!bannerEl || !document.body.contains(bannerEl)) {
      bannerEl = buildBanner();
    }
    const { node } = locateBodyNode();
    if (node && node.parentNode && bannerEl.parentNode !== node.parentNode) {
      node.parentNode.insertBefore(bannerEl, node); // above the email body
    }
    return !!node;
  }

  // The textContent-only sink object verdict_ui.applyPlan writes through.
  const bannerDom = {
    setBannerVisible(v) {
      if (v) { ensureBannerPlaced(); if (bannerParts) bannerParts.root.style.display = 'block'; }
      else if (bannerParts) bannerParts.root.style.display = 'none';
    },
    setBannerText(t) { if (bannerParts) bannerParts.attribution.textContent = t; },
    setProbabilityText(t) {
      if (bannerParts) { bannerParts.probability.textContent = `Confidence: ${t}`; bannerParts.probability.style.display = 'block'; }
    },
    clearProbability() {
      if (bannerParts) { bannerParts.probability.textContent = ''; bannerParts.probability.style.display = 'none'; }
    },
    setCaveatVisible(v) { if (bannerParts) bannerParts.caveat.style.display = v ? 'block' : 'none'; },
    setStaleVisible(v) { if (bannerParts) bannerParts.stale.style.display = v ? 'block' : 'none'; },
    setRationale(labels) {
      if (!bannerParts) return;
      const ul = bannerParts.rationale;
      while (ul.firstChild) ul.removeChild(ul.firstChild); // clear (no innerHTML)
      for (const label of labels) {
        const li = document.createElement('li');
        li.textContent = label; // textContent only (R9)
        ul.appendChild(li);
      }
      ul.style.display = labels.length ? 'block' : 'none';
    },
    setDismissVisible(v) { if (bannerParts) bannerParts.dismiss.style.display = v ? 'inline-block' : 'none'; },
    setScanningVisible(_v) { /* v1: no passive scanning tier UI */ },
  };

  // ---- step-3 public probe ----------------------------------------------
  // Returns { open: bool, emailId, subject } describing the current view.
  // Never throws; missing pieces are null.
  function probeOpenEmail() {
    const node = findOpenMessageNode();
    const emailId = readEmailId(node);
    const subject = emailId ? readSubject() : null; // only read subject if an email is open
    return { open: emailId !== null, emailId, subject };
  }

  // ---- step-4 full extractor input --------------------------------------
  // The abstract EmailNode the feature extractor consumes: subject/sender/body/
  // urls. Each field is read independently so a single selector miss is isolable.
  function probeEmailNode() {
    const node = findOpenMessageNode();
    const emailId = readEmailId(node);
    if (emailId === null) return { open: false };
    const body = readBody();
    return {
      open: true,
      emailId,
      subject: readSubject(),
      sender: readSender(),
      body: body.text,
      bodySelector: body.selector, // which selector won (for live confirmation)
      urls: readUrls(),
    };
  }

  // expose on a page-context global (content_script.js consumes it)
  window.PhishGuardDom = {
    findOpenMessageNode,
    readEmailId,
    readSubject,
    readSender,
    readBody,
    readUrls,
    locateBodyNode,
    probeOpenEmail,
    probeEmailNode,
    bannerDom,
    _TAG: TAG,
  };

  console.log(`${TAG} dom_adapter loaded.`);
})();
