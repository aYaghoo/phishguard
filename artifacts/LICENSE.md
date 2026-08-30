# Model artifact license

The model artifacts in this directory (`lightgbm_model.json`,
`text_model.json`, `deploy_bundle.json`) were trained on the
**PhishFuzzer Dataset**:

> R. Toth, N. Gruschka, and T. Bisztray, *"The Phish, The Spam, and The
> Valid: Generating Feature-Rich Emails for Benchmarking LLMs,"*
> arXiv:2511.21448 [cs.CR].
> https://github.com/DataPhish/PhishFuzzer

That dataset is licensed under
[Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
Whether trained model parameters constitute an adaptation of their training
data is legally unsettled; to honor the ShareAlike condition under any
reading, these artifacts are made available under the same license:

**CC BY-SA 4.0** — you may share and adapt these artifacts, including
commercially, provided you give appropriate attribution (to the dataset
authors above and to this project) and distribute any derivatives under the
same license.

The artifacts were produced from a cleaned and restructured version of the
corpus (deduplication, language filtering, encoding repair, email-address
masking); the cleaning process is documented in the project's system
overview. The source **code** of this extension is separately licensed under
MIT — see the [LICENSE](../LICENSE) file in the repository root.
