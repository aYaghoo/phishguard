# PhishGuard

On-device phishing detection for Gmail, as a Chrome (Manifest V3) extension.
PhishGuard flags likely phishing **in the Gmail reading pane, on the device**:
two detectors combine through calibrated late fusion inside an offscreen
document — a TF-IDF + logistic-regression text head and a LightGBM structured
head. No email leaves the machine.

> Full system overview — pipeline, data cleaning, calibration, results with
> confidence intervals, and security posture:
> **https://YOURDOMAIN/projects/phishguard**

## How it works

An opened message is traced end to end:

1. **Adapt** — a content script reads the open Gmail message into a stable DOM
   adapter (subject, body, sender, links).
2. **Extract** — URL features are computed: domain entropy, subdomain depth,
   link count.
3. **Score ×2** — the text head reads subject + body; LightGBM reads the
   structured features. Both run warm in the offscreen document.
4. **Fuse** — the two calibrated probabilities combine in log-odds space, then
   a prevalence shift re-scales the score from the 33.9% training rate to an
   assumed ~1% deployment rate.
5. **Verdict** — a single banner: confidence plus a provisional-rate caveat.

Each head is trained and calibrated on its own; they meet only at the end.
Mail with no URLs carries no structured signal, so it is routed to the text
head alone under separately fitted fusion weights and its own threshold.

The text head is a pure-JavaScript reimplementation of the trained sklearn
pipeline's inference logic (`text_model.js`) — same tokenizer rule, n-gram
joining, IDF weights, and coefficients, read unchanged from the exported
model, verified against sklearn's probabilities on a battery of edge-case
strings.

## Results

Measured on a held-out internal test set, with 95% confidence intervals from
a cluster bootstrap (near-duplicate clusters resampled as whole blocks, so
near-twins are never counted as independent evidence):

| Metric | Value | 95% CI | Nature |
|---|---|---|---|
| Recall | 0.880 | [0.826, 0.927] | Measured; prevalence-invariant |
| Precision | 0.810 | [0.579, 1.000] | Extrapolated to an assumed 1% phishing prevalence |
| False-alarm budget | ≈2.06 / 1,000 legitimate emails | — | Pinned by design; the threshold realizes it |

The precision figure is conditional on the assumed deployment prevalence,
which was never independently measured; read it as an order of precision with
a lower bound near 0.58, not a precise range. The operating point is defined
by the false-alarm budget, not a recall target.

## Security posture

- **No network.** The only permission is `offscreen`; the only host permission
  is `mail.google.com`. The CSP pins `connect-src` to `'none'`, so the
  extension has no outbound channel — nothing can be transmitted.
- **Email content is handled only as data.** It is read from the DOM as text,
  tokenized, and reduced to a numeric feature vector before scoring — never
  evaluated as code or rendered as HTML. Every DOM write goes through
  `textContent`.
- **No remote code.** Models ship inside the extension as JSON artifacts and
  are loaded via `chrome.runtime.getURL`; the artifact loader validates the
  bundle and refuses to score if it is incoherent.

## Install (unpacked)

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder (the one
   containing `manifest.json`).
4. Open Gmail and read a message; scoring runs locally as the message renders.

Requires Chrome 116+.

## Repository layout

```
manifest.json           MV3 manifest: single host permission, connect-src 'none'
content_script.js       entry point in the Gmail page
dom_adapter.js          stable read/write layer over Gmail's DOM (textContent only)
feature_extractor.js    URL + text feature computation
text_model.js           TF-IDF + logistic regression inference (JS port of sklearn)
lightgbm_model.js       LightGBM tree ensemble inference
lightgbm_runner.js      structured-head runner
fusion.js               log-odds fusion, Platt recalibration, prevalence shift
verdict_ui.js           banner rendering (textContent-only writes)
offscreen.html / .js    offscreen document that hosts the warm scoring chain
service_worker.js       message routing between content script and offscreen doc
artifact_loader.js      bundle validation; refuses to run on incoherent artifacts
artifacts/              exported model weights and fusion parameters (JSON)
```

Training, export, and the sklearn-parity harness live in a separate research
codebase; this repository contains the deployable extension and its exported
artifacts.

## Training data & attribution

The models were trained on the **PhishFuzzer Dataset** (3,300 human-authored
seed emails, each expanded into six LLM-rephrased variants):

> R. Toth, N. Gruschka, and T. Bisztray, *"The Phish, The Spam, and The
> Valid: Generating Feature-Rich Emails for Benchmarking LLMs,"*
> arXiv:2511.21448 [cs.CR].
> Dataset: https://github.com/DataPhish/PhishFuzzer
> (published as an open-science release; no explicit license at the time of
> writing — see [`artifacts/LICENSE.md`](artifacts/LICENSE.md))

The corpus was cleaned and restructured before training (deduplication,
language filtering, mojibake repair, email-address masking, family-aware
grouped splitting); the full cleaning ladder and leakage defenses are
documented in the [system overview](https://YOURDOMAIN/projects/phishguard).
The **E-PhishLLM** corpus was used only as a held-out cross-generator
evaluation probe; it is not redistributed here and no shipped artifact
derives from it:

> L. Pajola, E. Caripoti, S. Pizzi, M. Conti, S. Banzer, and G. Apruzzese,
> *"E-PhishGen: Unlocking Novel Research in Phishing Email Detection,"*
> ACM Workshop on Artificial Intelligence and Security (AISec), 2025.
> arXiv:2509.01791. Dataset: https://github.com/pajola/e-phishGen

## License

The **code** in this repository is [MIT](LICENSE).

The **model artifacts** in [`artifacts/`](artifacts/) are trained on the
CC BY-SA 4.0–licensed PhishFuzzer Dataset and are made available under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); see
[`artifacts/LICENSE.md`](artifacts/LICENSE.md).
