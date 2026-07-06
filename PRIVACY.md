# Privacy Policy for GitNotes

Last updated: 2026-07-05

GitNotes is a Chrome extension that shows `git notes` on GitHub commit and pull request pages. When you view commits on `github.com`, the extension requests note data from the GitHub REST API and displays it in your browser.

## What data GitNotes stores locally

GitNotes stores data only in your browser:

- **Optional GitHub token**: If you add a fine-grained personal access token in Options, it is stored in `chrome.storage.local`.
- **Local cache and library data**: IndexedDB stores note blobs, per-commit note cache entries, repository note-ref data, note metadata, and commit info to make the extension faster.
- **Local viewing history**: IndexedDB stores note view events with timestamps (for the extension's Hub/library experience).

This data is not sent to a GitNotes backend because GitNotes does not operate any developer-run servers.

## What data is transmitted

- GitNotes sends requests **only** to `https://api.github.com/*`.
- If you provide a token, GitNotes sends it **only** to `api.github.com` as an `Authorization` header.
- The GitHub pages you visit determine which repositories and commit SHAs are queried.

## What GitNotes does not do

GitNotes does **not**:

- collect analytics or telemetry,
- run or use developer-operated servers,
- sell or share your data with data brokers or advertisers,
- use your data for advertising,
- track you across websites.

## Chrome Web Store Limited Use Disclosure

GitNotes complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/) including Limited Use requirements.

Any data accessed by GitNotes is used only to provide the extension's single purpose: showing Git `notes` content for commits you view on GitHub and supporting related local caching/library features. Data is not sold, not used for advertising, and not transferred to third parties except as needed to call GitHub's API at your direction. No human reviews your extension data.

## Your controls

- You can remove your optional GitHub token at any time from the extension Options page.
- You can remove individual note entries from the Hub/library inside the extension.
- If you uninstall GitNotes, Chrome removes the extension and its local storage (including `chrome.storage.local` and extension IndexedDB data).

## Changes to this policy

If this privacy policy changes, updates will be posted in this file at:

<https://github.com/ZackarySantana/gitnotes/blob/main/PRIVACY.md>

## Contact

For questions or privacy requests, open an issue at:

<https://github.com/ZackarySantana/gitnotes/issues>
