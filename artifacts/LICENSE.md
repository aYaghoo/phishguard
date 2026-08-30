# Model artifact license

The model artifacts in this directory (`lightgbm_model.json`,
`text_model.json`, `deploy_bundle.json`) were trained on the
**PhishFuzzer Dataset**:

> R. Toth, N. Gruschka, and T. Bisztray, *"The Phish, The Spam, and The
> Valid: Generating Feature-Rich Emails for Benchmarking LLMs,"*
> arXiv:2511.21448 [cs.CR].
> https://github.com/DataPhish/PhishFuzzer

The dataset is published by its authors as an open-science release ("fully
open-source framework and dataset"); at the time of writing, its repository
does not state an explicit license. Whether trained model parameters
constitute an adaptation of training data is legally unsettled in any case.
Out of caution, these artifacts are made available under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/):

**CC BY-SA 4.0** — you may share and adapt these artifacts, including
commercially, provided you give appropriate attribution (to the dataset
authors above and to this project) and distribute any derivatives under the
same license. This notice will be updated if the dataset's license is
clarified.

The artifacts were produced from a cleaned and restructured version of the
corpus (deduplication, language filtering, encoding repair, email-address
masking); the cleaning process is documented in the project's system
overview. The source **code** of this extension is separately licensed under
MIT — see the [LICENSE](../LICENSE) file in the repository root.
