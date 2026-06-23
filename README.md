# UTC → Local Time

A Chrome (Manifest V3) extension that finds **UTC / GMT timestamps in the text of
any web page** and shows them in **your local time**, in place. The original UTC
value is kept on hover, so nothing is lost.

It correctly handles the tricky case where a timestamp is split across separate
DOM elements — e.g. the [status.claude.com](https://status.claude.com) format:

```html
<small>
  Jun <var data-var="date">20</var>, <var data-var="time">18:02</var> UTC
</small>
```

The date (`20`) and time (`18:02`) live in different `<var>` elements, so a naive
per-text-node scan misses it. This extension reconstructs the inline text, matches
`Jun 20, 18:02 UTC` as a whole, and replaces it with your local time.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Visit a page with UTC times (or open `test/demo.html`). Converted times get a
   subtle dotted underline — hover to see the original.

> To run on local `file://` pages (like the demo), open the extension's **Details**
> page and enable **Allow access to file URLs**.

## How it works

- **`parser.js`** — a pure, DOM-free engine (`UtcParser`) that detects timestamps,
  builds the exact UTC instant via `Date.UTC` (never the ambiguous `Date.parse`),
  and formats it in local time with `Intl.DateTimeFormat`.
- **`content.js`** — the DOM layer. It walks the page grouping inline runs (so
  split-node timestamps are seen whole), replaces each match with a
  `<span class="utc2l">`, and watches for dynamic/SPA updates with a debounced
  `MutationObserver`. Conversions are idempotent (never double-converted) and
  fully reversible.
- **`popup.html` / `popup.js`** — settings, stored in `chrome.storage.sync` and
  applied live without a page reload.

### Supported formats

| Example | Notes |
|---|---|
| `2026-06-20T18:02:33Z` | ISO 8601 (Zulu), incl. lowercase `t`/`z` |
| `2026-06-20T18:02:33+05:30` | ISO 8601 with numeric offset (bounded to ±14:00) |
| `20260620T180233Z` | ISO 8601 basic |
| `Jun 20, 18:02 UTC` | Month/day + time, **year inferred** (split-node target) |
| `Jun 13, 2026 - 00:50 UTC` | Month/day/year + time |
| `Jun 20, 2026, 6:02 PM UTC` | 12-hour time |
| `Sat, 20 Jun 2026 18:02:33 GMT` | RFC 1123 / HTTP date (weekday validated) |
| `Saturday, 20-Jun-26 18:02:33 GMT` | RFC 850 |
| `Sun Nov  6 08:49:37 1994` | asctime |
| `2026/06/20 18:02 UTC` | Numeric year-first date + time |
| `18:02 UTC`, `9:30 UTC` | Time only (anchored to today's date) |

### What it deliberately ignores (false-positive guards)

`16:9` aspect ratios, `3:2` scores, `v1.2.3` versions, durations (`5:00
remaining`), **offset-bearing zones** (`14:30 GMT+5` — would otherwise convert
wrong), non-UTC zones (`18:02 EST`), impossible dates (`Feb 30`), and anything
inside `<code>`, `<pre>`, `<input>`, `<textarea>`, or `contenteditable`.

## Settings (toolbar popup)

- **Enabled** — master on/off.
- **Time format** — Auto (from your locale) / 12-hour / 24-hour.
- **Show time zone** — append your zone label (e.g. `EDT`).
- **Run on this site** — per-site override.
- A live count of conversions on the current tab.

## Privacy Policy

**Effective date:** June 23, 2026

UTC → Local Time is built to do one thing — convert UTC/GMT timestamps on a page
into your local time — and to do it entirely on your own device.

### Data we collect

**None.** The extension does not collect, store, transmit, sell, or share any
personal data or browsing activity. Specifically, it does **not**:

- collect personally identifiable information, health, financial, or location data;
- read, log, or transmit the content of the pages you visit;
- track your browsing history, clicks, or behavior;
- use analytics, telemetry, advertising, or fingerprinting;
- contain any remote or third‑party code.

### Data we store

The only data the extension stores is **your own settings** — whether it's
enabled, your time-format choice, the show-time-zone option, and your per-site
on/off list. These are saved with the browser's `chrome.storage.sync` API so they
follow your Chrome profile across devices. They live in your browser (and your
own Google account's Chrome sync), are used solely to remember your preferences,
and are never sent to us or anyone else — we operate no servers and receive
nothing.

### Network activity

The extension makes **no network requests** of any kind. All timestamp detection
and conversion happens locally, in the page, using your browser's built-in date
and time-zone facilities.

### Permissions

- **`storage`** — to persist the settings described above. This is the extension's
  only permission. It requests **no host permissions** and uses no `tabs`/history/
  cookies access; it simply re-renders timestamp text that is already present on
  the page you're viewing.

### Changes

If this policy ever changes, the updated version will be posted here with a new
effective date.

### Contact

Questions about privacy? Contact `thebguy.github@gmail.com`.

## Development & testing

No build step — it's plain JS. Tests are dependency-free for the parser:

```bash
node test/parser.test.js     # 35 assertions: formats, offsets, false positives
```

The DOM layer (`content.js`) has a jsdom integration test covering the split-node
case, the live observer, and idempotency. To run it:

```bash
mkdir itest && cd itest && npm init -y && npm i jsdom
# then point a small jsdom harness at ../parser.js and ../content.js
```

`test/demo.html` is a manual visual check with positive and negative examples and
a button that injects a timestamp to exercise the observer.

## Known limitations

- Closed Shadow DOM is inaccessible to any extension; open shadow roots are
  supported.
- Cross-origin iframes are handled per-frame (the script injects into each frame).
- Time ranges (`09:00 UTC to 17:00 UTC`) are converted as two independent times.
- Bare times with no date (`18:02 UTC`) are anchored to today's UTC date.
