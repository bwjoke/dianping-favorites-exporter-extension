# Privacy

Dianping Favorites Exporter Local runs entirely inside the user's local Chrome browser.

## Data Access

The extension can access only Dianping domains declared in `manifest.json`:

- `*.dianping.com`

It reads favorite list pages and optional merchant detail pages visible to the currently signed-in user.

## Data Storage

The extension does not upload, sync, or persist favorite data through any remote service. Exported data is downloaded locally as `CSV` and `JSONL` files.

The extension does not use `chrome.storage`, `localStorage`, IndexedDB, analytics, telemetry, or third-party APIs.

## Sensitive Data

Exports may contain personal preference data, including saved merchants, locations, categories, tags, and inferred interests.

Generated export files match `dianping-favorites-*` and should not be committed to public repositories or sent to untrusted parties.

## Cookies And Session

The extension does not read or export cookies. Network requests use the active Chrome Dianping session through standard browser credential handling so Dianping can return pages the user is already allowed to view.
