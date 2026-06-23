/**
 * content.js — DOM layer for the "UTC → Local Time" extension.
 *
 * Responsibilities:
 *   - Walk the page, grouping inline runs so a timestamp split across sibling
 *     nodes (e.g. status.claude.com's "Jun <var>20</var>, <var>18:02</var> UTC")
 *     is matched as a whole, not missed.
 *   - Convert each UTC/GMT/ISO match to local time, wrapping it in a small
 *     <span class="utc2l"> that keeps the original on hover and is idempotent.
 *   - React to dynamic / SPA content via a debounced MutationObserver.
 *   - Read settings from chrome.storage.sync and react live to changes
 *     (enable/disable, per-site disable, 12h/24h, timezone label) without reload.
 *   - Answer the popup's status query (hostname, conversion count, site state).
 *
 * All timestamp parsing/formatting lives in parser.js (UtcParser); this file is
 * the only one that touches the DOM. UtcParser is shared via the content
 * script's isolated-world global scope (parser.js is listed first in manifest).
 */
(function () {
  "use strict";

  if (typeof UtcParser === "undefined") return; // parser failed to load
  if (window.__utc2lLoaded) return;             // guard against double injection
  window.__utc2lLoaded = true;

  // --- Constants -------------------------------------------------------------

  // Inline elements: descend into these as part of the current inline run so a
  // timestamp spanning them is reconstructed whole.
  var INLINE_TAGS = new Set([
    "A", "ABBR", "B", "BDI", "BDO", "BIG", "CITE", "DATA", "DEL", "DFN", "EM",
    "FONT", "I", "INS", "LABEL", "MARK", "NOBR", "OUTPUT", "Q", "RP", "RT",
    "RUBY", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "TT", "U",
    "VAR", "WBR"
  ]);

  // Subtrees we never read or modify (code, inputs, scripts, our own output).
  var SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP",
    "XMP", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH", "CANVAS"
  ]);

  var WRAPPER_TAG = "SPAN";
  var WRAPPER_CLASS = "utc2l";
  var MARK_ATTR = "data-utc2l";
  var MAX_MATCHES_PER_SWEEP = 5000; // pathological-page backstop

  // --- State -----------------------------------------------------------------

  var settings = {
    enabled: true,
    hourFormat: "auto",   // "auto" | "12" | "24"
    showTimezone: true,
    disabledSites: []     // array of hostnames
  };

  var hostname = location.hostname || "";
  var active = false;          // currently converting on this page?
  var conversionCount = 0;     // conversions made on this page this session
  var observer = null;
  var observedRoots = new WeakSet();
  var pendingRoots = new Set();
  var flushScheduled = false;
  var applying = false;        // true while we mutate, to ignore our own records

  // --- Settings --------------------------------------------------------------

  function siteDisabled() {
    return settings.disabledSites.indexOf(hostname) !== -1;
  }

  function shouldRun() {
    return settings.enabled && !siteDisabled();
  }

  function loadSettings(cb) {
    try {
      chrome.storage.sync.get(settings, function (stored) {
        if (stored && !chrome.runtime.lastError) {
          settings.enabled = stored.enabled !== false;
          settings.hourFormat = stored.hourFormat || "auto";
          settings.showTimezone = stored.showTimezone !== false;
          settings.disabledSites = Array.isArray(stored.disabledSites) ? stored.disabledSites : [];
        }
        cb();
      });
    } catch (e) {
      cb(); // chrome.storage unavailable (e.g. restricted page) -> use defaults
    }
  }

  // --- Conversion helpers ----------------------------------------------------

  function formatOpts(showDate, showSeconds) {
    return {
      hourFormat: settings.hourFormat,
      showZone: settings.showTimezone,
      showDate: showDate,
      showSeconds: showSeconds
    };
  }

  // Build the replacement element for one match.
  function makeWrapper(date, match) {
    var fields = match.fields;
    var showDate = !fields.timeOnly;
    var showSeconds = !!fields.hasSeconds;
    var local = UtcParser.formatLocal(date, formatOpts(showDate, showSeconds));
    if (!local) return null;

    var el = document.createElement(WRAPPER_TAG);
    el.className = WRAPPER_CLASS;
    el.setAttribute(MARK_ATTR, "1");
    el.setAttribute("data-utc2l-iso", date.toISOString());
    el.setAttribute("data-utc2l-orig", match.raw);
    el.setAttribute("data-utc2l-date", showDate ? "1" : "0");
    el.setAttribute("data-utc2l-sec", showSeconds ? "1" : "0");
    el.title = "Original: " + match.raw;
    el.setAttribute("aria-label", local + " (local time; original " + match.raw + ")");
    el.textContent = local;
    return el;
  }

  // Re-render an existing wrapper from its stored ISO instant + flags.
  function rerenderWrapper(el) {
    var iso = el.getAttribute("data-utc2l-iso");
    if (!iso) return;
    var date = new Date(iso);
    if (isNaN(date.getTime())) return;
    var showDate = el.getAttribute("data-utc2l-date") !== "0";
    var showSeconds = el.getAttribute("data-utc2l-sec") === "1";
    var local = UtcParser.formatLocal(date, formatOpts(showDate, showSeconds));
    if (!local) return;
    var orig = el.getAttribute("data-utc2l-orig") || "";
    el.textContent = local;
    el.setAttribute("aria-label", local + " (local time; original " + orig + ")");
  }

  // --- Tree walking & inline-group reconstruction ----------------------------

  function isSkipped(el) {
    if (el.nodeType !== Node.ELEMENT_NODE) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(MARK_ATTR)) return true;         // our own output
    if (el.isContentEditable) return true;               // user-editable text
    return false;
  }

  function isInline(el) {
    return INLINE_TAGS.has(el.tagName);
  }

  // Scan an element: gather maximal inline runs separated by block boundaries,
  // convert each run, and recurse into block children + open shadow roots.
  function scanElement(root) {
    if (isSkipped(root)) return;

    var group = []; // text nodes in the current inline run

    function flush() {
      if (group.length) {
        convertGroup(group);
        group = [];
      }
    }

    function gather(el) {
      var child = el.firstChild;
      while (child) {
        var next = child.nextSibling;
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.nodeValue && child.nodeValue.length) group.push(child);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (isSkipped(child)) {
            flush(); // a skipped element breaks the inline run
          } else if (isInline(child)) {
            gather(child); // inline: its text joins the current run
            if (child.shadowRoot) scanRoot(child.shadowRoot);
          } else {
            flush();          // block boundary
            scanElement(child); // process the block as its own scope
          }
        }
        child = next;
      }
    }

    gather(root);
    flush();

    if (root.shadowRoot) scanRoot(root.shadowRoot);
  }

  // Scan a Document/ShadowRoot container: process its element children and, for
  // shadow roots, ensure we observe future mutations inside them too.
  function scanRoot(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === Node.DOCUMENT_FRAGMENT_NODE) observeRoot(rootNode);
    var child = rootNode.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === Node.ELEMENT_NODE) {
        scanElement(child);
      } else if (child.nodeType === Node.TEXT_NODE && child.nodeValue) {
        // A bare text node directly under the root: process its (single-node) run.
        convertGroup([child]);
      }
      child = next;
    }
  }

  // Convert all matches within one inline run (an ordered list of text nodes).
  function convertGroup(textNodes) {
    if (!textNodes.length) return;

    // Build the combined string + an offset map back to the contributing nodes.
    var combined = "";
    var map = [];
    for (var i = 0; i < textNodes.length; i++) {
      var n = textNodes[i];
      var data = n.nodeValue || "";
      map.push({ node: n, start: combined.length, len: data.length });
      combined += data;
    }

    var matches = UtcParser.findMatches(combined);
    if (!matches.length) return;

    var ref = new Date(); // "now" for year inference (DOM layer may use clock)
    var todayUTC = { y: ref.getUTCFullYear(), mo: ref.getUTCMonth(), d: ref.getUTCDate() };

    // Apply right-to-left so DOM mutations don't invalidate earlier offsets.
    for (var mi = matches.length - 1; mi >= 0; mi--) {
      if (conversionCount >= MAX_MATCHES_PER_SWEEP) break;
      var match = matches[mi];
      var opts = { referenceDate: ref };
      if (match.fields.timeOnly) opts.mergeDate = todayUTC;

      var date = UtcParser.parseToUtcDate(match.fields, opts);
      if (!date) continue; // unresolvable (e.g. bare time we can't anchor) -> leave as-is

      var wrapper = makeWrapper(date, match);
      if (!wrapper) continue;

      var startPos = locate(map, match.index, false);
      var endPos = locate(map, match.index + match.length, true);
      if (!startPos || !endPos) continue;

      try {
        var range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        range.deleteContents();
        range.insertNode(wrapper);
        conversionCount++;
      } catch (e) {
        // Range can throw if the DOM shifted under us; skip this match.
      }
    }
  }

  // Map a global offset in the combined string back to {node, offset}.
  //
  // `isEnd` makes boundary indices bind to the correct node: a match START at a
  // node boundary binds to the FOLLOWING node (offset 0); a match END binds to
  // the PRECEDING node (offset = its length). This matters because adjacent text
  // nodes can live under different parents (e.g. a body-level whitespace node
  // sitting beside a <small>'s inner text). Binding a start to the previous
  // node's end would make the Range span across parents and delete too much.
  function locate(map, gi, isEnd) {
    for (var i = 0; i < map.length; i++) {
      var e = map[i];
      var lo = e.start, hi = e.start + e.len;
      if (isEnd) {
        if (gi > lo && gi <= hi) return { node: e.node, offset: gi - lo };
      } else {
        if (gi >= lo && gi < hi) return { node: e.node, offset: gi - lo };
      }
    }
    // Fallbacks for the extreme edges (start at very end / end at very start).
    if (map.length === 0) return null;
    if (isEnd) {
      var last = map[map.length - 1];
      return { node: last.node, offset: last.len };
    }
    var first = map[0];
    return { node: first.node, offset: 0 };
  }

  // --- MutationObserver (dynamic content) ------------------------------------

  function observeRoot(rootNode) {
    if (!rootNode || observedRoots.has(rootNode)) return;
    observedRoots.add(rootNode);
    if (!observer) observer = new MutationObserver(onMutations);
    observer.observe(rootNode, { childList: true, subtree: true, characterData: true });
  }

  function onMutations(records) {
    if (applying) return; // ignore mutations we caused
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (rec.type === "characterData") {
        var p = rec.target.parentNode;
        if (p && p.nodeType === Node.ELEMENT_NODE) queueRoot(p);
      } else {
        for (var j = 0; j < rec.addedNodes.length; j++) {
          var node = rec.addedNodes[j];
          if (node.nodeType === Node.ELEMENT_NODE) queueRoot(node);
          else if (node.nodeType === Node.TEXT_NODE && node.parentNode &&
                   node.parentNode.nodeType === Node.ELEMENT_NODE) {
            queueRoot(node.parentNode);
          }
        }
      }
    }
    scheduleFlush();
  }

  function queueRoot(el) {
    // Don't queue something inside our own output.
    if (el.closest && el.closest("[" + MARK_ATTR + "]")) return;
    pendingRoots.add(el);
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    var run = function () {
      flushScheduled = false;
      flushPending();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 200);
    }
  }

  function flushPending() {
    if (!active || pendingRoots.size === 0) return;
    var roots = Array.from(pendingRoots);
    pendingRoots.clear();

    // Drop roots that are contained within another queued root (dedupe work).
    var filtered = roots.filter(function (r) {
      if (!r.isConnected) return false;
      for (var k = 0; k < roots.length; k++) {
        if (roots[k] !== r && roots[k].contains && roots[k].contains(r)) return false;
      }
      return true;
    });

    withApplying(function () {
      for (var i = 0; i < filtered.length; i++) scanElement(filtered[i]);
    });

    notifyCountChanged();
  }

  // Run fn while suppressing our own mutation records.
  function withApplying(fn) {
    applying = true;
    try {
      fn();
    } finally {
      if (observer) observer.takeRecords(); // discard records we just caused
      applying = false;
    }
  }

  // --- Activation / deactivation ---------------------------------------------

  function activate() {
    if (active) return;
    active = true;
    withApplying(function () {
      scanElement(document.body || document.documentElement);
    });
    observeRoot(document.documentElement || document.body);
    notifyCountChanged();
  }

  function deactivate() {
    active = false;
    if (observer) {
      observer.disconnect();
      observer = null;
      observedRoots = new WeakSet();
    }
    pendingRoots.clear();
    revertAll();
    conversionCount = 0;
    notifyCountChanged();
  }

  function revertAll() {
    var nodes = document.querySelectorAll("[" + MARK_ATTR + "]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var orig = el.getAttribute("data-utc2l-orig");
      if (orig != null) {
        el.replaceWith(document.createTextNode(orig));
      }
    }
  }

  function rerenderAll() {
    var nodes = document.querySelectorAll("[" + MARK_ATTR + "]");
    for (var i = 0; i < nodes.length; i++) rerenderWrapper(nodes[i]);
  }

  // --- Popup messaging -------------------------------------------------------

  function notifyCountChanged() {
    try {
      chrome.runtime.sendMessage({ type: "utc2l:count", count: conversionCount }, function () {
        // Read lastError to silence "Could not establish connection" when no
        // popup is open to receive the message.
        void chrome.runtime.lastError;
      });
    } catch (e) { /* messaging unavailable */ }
  }

  function handleMessage(msg, sender, sendResponse) {
    if (!msg || msg.type !== "utc2l:getStatus") return;
    sendResponse({
      hostname: hostname,
      count: conversionCount,
      active: active,
      siteDisabled: siteDisabled(),
      enabled: settings.enabled
    });
    return true;
  }

  try {
    chrome.runtime.onMessage.addListener(handleMessage);
  } catch (e) { /* messaging unavailable */ }

  // --- React to settings changes ---------------------------------------------

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "sync") return;
      var wasRunning = shouldRun();
      var formatChanged = false;
      if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
      if (changes.disabledSites) {
        settings.disabledSites = Array.isArray(changes.disabledSites.newValue)
          ? changes.disabledSites.newValue : [];
      }
      if (changes.hourFormat) { settings.hourFormat = changes.hourFormat.newValue || "auto"; formatChanged = true; }
      if (changes.showTimezone) { settings.showTimezone = changes.showTimezone.newValue !== false; formatChanged = true; }

      var nowRunning = shouldRun();
      if (nowRunning && !wasRunning) {
        activate();
      } else if (!nowRunning && wasRunning) {
        deactivate();
      } else if (nowRunning && formatChanged) {
        withApplying(rerenderAll);
      }
    });
  } catch (e) { /* storage unavailable */ }

  // --- Boot ------------------------------------------------------------------

  loadSettings(function () {
    if (shouldRun()) activate();
  });
})();
