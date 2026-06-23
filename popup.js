/**
 * popup.js — settings UI for "UTC → Local Time".
 *
 * Settings live in chrome.storage.sync; the content script reads them and reacts
 * to changes live (no reload). The popup also asks the active tab's content
 * script for its hostname + conversion count to power the per-site toggle and
 * the live counter.
 */
(function () {
  "use strict";

  var DEFAULTS = {
    enabled: true,
    hourFormat: "auto",
    showTimezone: true,
    disabledSites: []
  };

  var els = {
    enabled: document.getElementById("enabled"),
    hourFormat: document.getElementById("hourFormat"),
    showTimezone: document.getElementById("showTimezone"),
    siteToggle: document.getElementById("siteToggle"),
    siteName: document.getElementById("siteName"),
    siteHint: document.getElementById("siteHint"),
    count: document.getElementById("count")
  };

  var state = { settings: null, hostname: null };

  function getSettings(cb) {
    chrome.storage.sync.get(DEFAULTS, function (s) {
      state.settings = {
        enabled: s.enabled !== false,
        hourFormat: s.hourFormat || "auto",
        showTimezone: s.showTimezone !== false,
        disabledSites: Array.isArray(s.disabledSites) ? s.disabledSites : []
      };
      cb();
    });
  }

  function save(patch) {
    Object.assign(state.settings, patch);
    chrome.storage.sync.set(patch);
  }

  function renderGlobal() {
    var s = state.settings;
    els.enabled.checked = s.enabled;
    els.hourFormat.value = s.hourFormat;
    els.showTimezone.checked = s.showTimezone;
  }

  function renderSite() {
    if (!state.hostname) {
      els.siteName.textContent = "this site";
      els.siteToggle.checked = false;
      els.siteToggle.disabled = true;
      els.siteHint.textContent = "Not available on this page";
      return;
    }
    els.siteToggle.disabled = false;
    els.siteName.textContent = state.hostname;
    var disabled = state.settings.disabledSites.indexOf(state.hostname) !== -1;
    // Toggle ON = run on this site.
    els.siteToggle.checked = !disabled;
    els.siteHint.textContent = disabled ? "Currently off here" : "Currently on here";
  }

  function renderCount(count, active, siteOff) {
    if (state.hostname == null) {
      els.count.textContent = "No active page detected.";
      return;
    }
    if (!state.settings.enabled) {
      els.count.innerHTML = "<span class='disabled-note'>Extension is off.</span>";
      return;
    }
    if (siteOff) {
      els.count.innerHTML = "<span class='disabled-note'>Off for this site.</span>";
      return;
    }
    var n = count || 0;
    els.count.innerHTML = "Converted <b>" + n + "</b> timestamp" + (n === 1 ? "" : "s") + " on this page.";
  }

  // Ask the active tab's content script for status.
  function queryActiveTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id) { cb(null); return; }
      chrome.tabs.sendMessage(tab.id, { type: "utc2l:getStatus" }, function (resp) {
        // lastError set when no content script (chrome://, store pages, etc.)
        void chrome.runtime.lastError;
        cb(resp || null);
      });
    });
  }

  function refreshStatus() {
    queryActiveTab(function (resp) {
      if (resp && resp.hostname) {
        state.hostname = resp.hostname;
        renderSite();
        renderCount(resp.count, resp.active, resp.siteDisabled);
      } else {
        state.hostname = null;
        renderSite();
        renderCount(0, false, false);
      }
    });
  }

  // Live count updates pushed by the content script as it converts.
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "utc2l:count" && state.hostname) {
      var siteOff = state.settings.disabledSites.indexOf(state.hostname) !== -1;
      renderCount(msg.count, true, siteOff);
    }
  });

  // --- Wire up controls ---
  els.enabled.addEventListener("change", function () {
    save({ enabled: els.enabled.checked });
    refreshStatus();
  });
  els.hourFormat.addEventListener("change", function () {
    save({ hourFormat: els.hourFormat.value });
  });
  els.showTimezone.addEventListener("change", function () {
    save({ showTimezone: els.showTimezone.checked });
  });
  els.siteToggle.addEventListener("change", function () {
    if (!state.hostname) return;
    var list = state.settings.disabledSites.slice();
    var idx = list.indexOf(state.hostname);
    if (els.siteToggle.checked) {
      if (idx !== -1) list.splice(idx, 1); // remove from disabled = enable
    } else {
      if (idx === -1) list.push(state.hostname); // add to disabled
    }
    save({ disabledSites: list });
    renderSite();
    refreshStatus();
  });

  // --- Init ---
  getSettings(function () {
    renderGlobal();
    refreshStatus();
  });
})();
