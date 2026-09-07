/**
 * PhishGuard v1 — Module 2: the Feature Extractor (feature_extractor.js)
 *
 * Browser port of feature_extractor.py (same contract logic, 1:1). Runs in the
 * page context: it is handed one DOM-derived email node and returns one
 * four-field payload deterministically.
 *
 * Responsibility (one job): DOM node -> {text, features[], rule_fires[],
 * support_flag}, same node -> same payload. Owns the Subject+Body assembly, the
 * structured feature vector (the LightGBM feature list), the support predicate,
 * and the hard-rule evaluation. Touches no model and computes no score. L_max=256
 * truncation is the runner's job (distilbert_runner), not here.
 *
 * Port split (same discipline as dom_adapter.js):
 *   (1) Contract logic (this file) — pure functions of an already-parsed email
 *       node ({subject, body, senderDisplay, senderDomain, urls}) and an
 *       injected brand map. Identical semantics to feature_extractor.py, so the
 *       two feature vectors cannot silently desync.
 *   (2) Browser binding — the parse of Gmail's DOM into that node lives behind
 *       the same single-DOM-contact discipline dom_adapter owns.
 *       `parseNode(bodyElement, doc)` is the one place DOM reads happen; the
 *       tests inject a plain object node, so the logic is exercised without a
 *       browser, and editing selectors is a one-place change.
 *
 * Known limitations / design notes:
 *   - sender_brand_mismatch counts toward support_flag (via
 *     SUPPORT_COUNTS_BRAND_MISMATCH, a single point of control) and is also in
 *     the LightGBM vector. Invariant: an IP-literal-only row must still route to
 *     the text-only head, since ip-literal is a rule input, not a vector field.
 *   - sender_brand_mismatch needs a bundled brand map. It is injected, default
 *     empty, so an absent map yields no signal rather than a false one; the wire
 *     exists and is tested before its first real payload.
 *   - support_flag routes on the presence of a domain (non-IP) URL: such rows
 *     go to full fusion so the structured head scores its URL features, while
 *     IP-literal-only and URL-less rows go to the text-only head. Benign
 *     URL-bearing mail is scored by the structured head as an accepted v1 risk.
 */

'use strict';

// ---------------------------------------------------------------------------
// Pinned contract constants (identical to the .py).
// ---------------------------------------------------------------------------

const SEP_TOKEN = ' [SEP] ';                 // C-d Subject/Body separator; runner owns L_max
let SUPPORT_COUNTS_BRAND_MISMATCH = true;    // [FX-alpha] single point of truth

// Positional feature contract (the retraining seam). ORDER IS LOAD-BEARING.
const INFORMATIVE_FEATURES = Object.freeze([
  'url_count',
  'has_url',
  'url_domain_entropy',
  'subdomain_count',
  'sender_brand_mismatch',
]);

// support_flag is true when the email has a domain (non-IP) URL, routing those
// rows to full fusion so the structured head scores its four URL features;
// IP-literal-only and URL-less rows go to the text-only head. Threshold-free —
// no invented entropy or subdomain cutoff. Benign unsubscribe mail routes to
// full fusion by design; the structured head scores it (diluted by the strong
// text head in the fused score). Accepted v1 risk: the structured head scores
// real benign URL-bearing mail without the deferred validation of that path.
// Mirrors feature_extractor.py.
const SIGNAL_CARRYING_DISCRETE_TELLS = Object.freeze(['has_url']);

function signalCarryingFeatures() {
  const feats = SIGNAL_CARRYING_DISCRETE_TELLS.slice();
  if (SUPPORT_COUNTS_BRAND_MISMATCH) feats.push('sender_brand_mismatch');
  return feats;
}

function featureIndex(name) {
  return INFORMATIVE_FEATURES.indexOf(name);
}

const EMPTY_BRAND_MAP = Object.freeze({});

// ---------------------------------------------------------------------------
// Text side (C-d): Subject-preserving assembly. Subject first, always.
// ---------------------------------------------------------------------------

function assembleSubjectBody(node) {
  const subject = node.subject || '';
  const body = node.body || '';
  if (!subject && !body) return '';           // no lone-separator phantom token
  return `${subject}${SEP_TOKEN}${body}`;
}

// ---------------------------------------------------------------------------
// URL host parsing. Deliberately dependency-free so it matches _host_of in the
// .py EXACTLY (a divergence would desync the two vectors).
// ---------------------------------------------------------------------------

const IP_LITERAL_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function hostOf(url) {
  if (!url) return '';
  let s = String(url).trim();
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  s = s.split(/[/?#]/, 1)[0];                 // cut path/query/fragment
  if (s.indexOf('@') !== -1) s = s.slice(s.lastIndexOf('@') + 1);  // userinfo
  if (s.indexOf(':') !== -1) s = s.split(':', 1)[0];               // port
  return s.toLowerCase();
}

function isIpLiteralHost(host) {
  if (!host || !IP_LITERAL_RE.test(host)) return false;
  return host.split('.').every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255;
  });
}

function shannonEntropy(s) {
  if (!s) return 0.0;
  const counts = Object.create(null);
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  const n = s.length;
  let ent = 0.0;
  for (const k in counts) {
    const p = counts[k] / n;
    ent -= p * Math.log2(p);
  }
  return ent;
}

function subdomainCount(host) {
  if (!host || isIpLiteralHost(host)) return 0;
  const labels = host.split('.').filter((l) => l !== '');
  return Math.max(0, labels.length - 2);
}

// ---------------------------------------------------------------------------
// sender_brand_mismatch [FX-beta]. Empty map -> always 0 (no false signal, C-g).
// ---------------------------------------------------------------------------

function senderBrandMismatch(display, domain, brandMap) {
  if (!brandMap || Object.keys(brandMap).length === 0 || !display || !domain) return 0;
  const d = display.toLowerCase();
  const dom = domain.toLowerCase();
  for (const brand of Object.keys(brandMap)) {
    if (d.indexOf(brand.toLowerCase()) !== -1) {
      const legit = brandMap[brand].map((x) => x.toLowerCase());
      return legit.indexOf(dom) === -1 ? 1 : 0;   // implied brand, wrong domain -> 1
    }
  }
  return 0;                                        // no listed brand implied -> no signal
}

// ---------------------------------------------------------------------------
// Structured vector (informative subset only). IP-literal hosts are excluded
// from host-structure stats: rule inputs are not structured support and must
// not pollute p_struct.
// ---------------------------------------------------------------------------

function buildInformativeVector(node, brandMap) {
  const urls = Array.isArray(node.urls) ? node.urls.slice() : [];
  const allHosts = urls.map(hostOf).filter((h) => h);
  const hosts = allHosts.filter((h) => !isIpLiteralHost(h));   // domain hosts only

  const urlCount = urls.length;
  const hasUrl = urls.length ? 1 : 0;

  let urlDomainEntropy = 0.0;
  let subCount = 0;
  if (hosts.length) {
    urlDomainEntropy = Math.max(...hosts.map(shannonEntropy));
    subCount = Math.max(...hosts.map(subdomainCount));
  }

  const brandMismatch = senderBrandMismatch(
    node.senderDisplay || '', node.senderDomain || '', brandMap
  );

  const vector = [urlCount, hasUrl, urlDomainEntropy, subCount, brandMismatch];
  if (vector.length !== INFORMATIVE_FEATURES.length) {
    throw new Error('informative vector arity must match INFORMATIVE_FEATURES (retraining seam)');
  }
  return vector;
}

// ---------------------------------------------------------------------------
// support predicate. Computed once, here. Reads by name.
// ---------------------------------------------------------------------------

function hasNonIpUrl(node) {
  // Routing signal: at least one URL with a domain (non-IP) host. IP-literal-only
  // rows return false and route to the text-only head, preserving the invariant
  // that IP-literals are rule inputs, not structured support. Mirrors
  // feature_extractor.py _has_non_ip_url.
  const urls = Array.isArray(node.urls) ? node.urls : [];
  for (const u of urls) {
    const h = hostOf(u);
    if (h && !isIpLiteralHost(h)) return true;
  }
  return false;
}

function anyInformativeStructuredFeaturePopulated(features, hasDomainUrl) {
  if (!Array.isArray(features) || features.length !== INFORMATIVE_FEATURES.length) {
    return false;    // fail safe toward the text-only head (no design blind to a malformed vector)
  }
  for (const name of signalCarryingFeatures()) {
    if (name === 'has_url') {
      // has_url as a support tell means 'has a non-IP (domain) URL', not the raw
      // has_url feature (which is 1 even for an IP-literal). Preserves the
      // IP-literal invariant while routing domain-URL rows to full fusion.
      if (hasDomainUrl) return true;
    } else if (features[featureIndex(name)] !== 0) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hard rules. The independently-triggering set is empty in v1 production.
// ---------------------------------------------------------------------------

function ruleUrlIsIpLiteral(node) {
  const urls = Array.isArray(node.urls) ? node.urls : [];
  for (const u of urls) {
    if (isIpLiteralHost(hostOf(u))) return true;
  }
  return false;
}

// v1 registry of independently-triggering rules. Empty in v1 production; adding
// an entry is the graduation step for a later release — one visible site.
const VALIDATED_TRIGGERING_RULES = Object.freeze([]);  // [{name, predicate}], empty in v1

function evaluateValidatedHardRules(node) {
  const fired = [];
  for (const { name, predicate } of VALIDATED_TRIGGERING_RULES) {
    if (predicate(node)) fired.push(name);
  }
  return fired;
}

// ---------------------------------------------------------------------------
// The one entry point.
// ---------------------------------------------------------------------------

function extract(node, brandMap, opts) {
  const bm = brandMap != null ? brandMap : EMPTY_BRAND_MAP;
  const testRules = opts && opts.testRules ? opts.testRules : null;

  const text = assembleSubjectBody(node);
  const features = buildInformativeVector(node, bm);
  const supportFlag = anyInformativeStructuredFeaturePopulated(features, hasNonIpUrl(node));

  let ruleFires;
  if (testRules) {
    // verification path (never reachable in production).
    ruleFires = [];
    for (const { name, predicate } of testRules) {
      if (predicate(node)) ruleFires.push(name);
    }
  } else {
    ruleFires = evaluateValidatedHardRules(node);   // [] in v1 prod
  }

  return Object.freeze({
    text,
    features: Object.freeze(features),
    rule_fires: Object.freeze(ruleFires),
    support_flag: supportFlag,
  });
}

// ---------------------------------------------------------------------------
// (2) Browser binding: the single DOM-contact site. In production this parses
// the dom_adapter's body Element into the abstract node. Kept thin and isolated.
// Not exercised by the logic tests (they inject a plain node).
// ---------------------------------------------------------------------------

function parseNode(bodyElement, doc) {
  // These selectors are placeholders, pending confirmation against live Gmail;
  // the contract logic above does not depend on them being correct.
  const textOf = (el) => (el && typeof el.textContent === 'string' ? el.textContent : '');
  const body = textOf(bodyElement);

  const d = doc || (typeof document !== 'undefined' ? document : null);
  let subject = '';
  let senderDisplay = '';
  let senderDomain = '';
  const urls = [];
  if (d) {
    const subjEl = d.querySelector('h2[data-thread-perm-id], [data-legacy-thread-id] h2');
    subject = textOf(subjEl);
    const fromEl = d.querySelector('span[email]');
    if (fromEl) {
      senderDisplay = fromEl.getAttribute('name') || textOf(fromEl);
      const addr = fromEl.getAttribute('email') || '';
      const at = addr.lastIndexOf('@');
      senderDomain = at !== -1 ? addr.slice(at + 1).toLowerCase() : '';
    }
  }
  if (bodyElement && typeof bodyElement.querySelectorAll === 'function') {
    for (const a of bodyElement.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (href) urls.push(href);
    }
  }
  return { subject, body, senderDisplay, senderDomain, urls };
}

(function(){
const __api = {
  // contract
  SEP_TOKEN,
  INFORMATIVE_FEATURES,
  EMPTY_BRAND_MAP,
  extract,
  // helpers exposed for tests / downstream (feature-by-name, matches .py)
  signalCarryingFeatures,
  featureIndex,
  assembleSubjectBody,
  buildInformativeVector,
  anyInformativeStructuredFeaturePopulated,
  evaluateValidatedHardRules,
  hostOf,
  isIpLiteralHost,
  shannonEntropy,
  subdomainCount,
  senderBrandMismatch,
  ruleUrlIsIpLiteral,
  parseNode,
  // test-only setters for the FX-alpha single point
  _setSupportCountsBrandMismatch: (v) => { SUPPORT_COUNTS_BRAND_MISMATCH = v; },
  _getSupportCountsBrandMismatch: () => SUPPORT_COUNTS_BRAND_MISMATCH,
};


// dual-mode export (Node CommonJS for parity + browser global for offscreen)
(function (root, api) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.FeatureExtractor = api;
  }
})(typeof self !== 'undefined' ? self : this, __api);
})();

