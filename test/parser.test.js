/**
 * Dependency-free test suite for parser.js. Run with:  node test/parser.test.js
 *
 * Uses a fixed reference "now" (Jun 21 2026, 12:00 UTC) so year-inference and
 * relative cases are deterministic.
 */
var UtcParser = require("../parser.js");

var REF = new Date(Date.UTC(2026, 5, 21, 12, 0, 0));
var passed = 0, failed = 0;
var failures = [];

function eq(actual, expected, label) {
  if (actual === expected) { passed++; }
  else { failed++; failures.push(label + "\n    expected: " + expected + "\n    actual:   " + actual); }
}

// Convert `text` (optionally with a mergeDate for bare times) and return the
// first match's UTC ISO string, or "NONE" if nothing converts.
function utcOf(text, opts) {
  var ms = UtcParser.findMatches(text);
  if (!ms.length) return "NONE";
  var o = Object.assign({ referenceDate: REF }, opts || {});
  var d = UtcParser.parseToUtcDate(ms[0].fields, o);
  return d ? d.toISOString() : "NULL";
}

function rawOf(text) {
  var ms = UtcParser.findMatches(text);
  return ms.length ? ms[0].raw : "NONE";
}

// ---------------------------------------------------------------------------
// Positive cases — should convert to the expected UTC instant.
// ---------------------------------------------------------------------------
eq(utcOf("Jun 20, 18:02 UTC"), "2026-06-20T18:02:00.000Z", "status.claude split-node (year inferred)");
eq(utcOf("Jun 13, 2026 - 00:50 UTC"), "2026-06-13T00:50:00.000Z", "Mon DD, YYYY - HH:MM UTC");
eq(utcOf("2026-06-20T18:02:33Z"), "2026-06-20T18:02:33.000Z", "ISO 8601 Zulu");
eq(utcOf("2026-06-20T18:02:33+05:30"), "2026-06-20T12:32:33.000Z", "ISO 8601 numeric offset");
eq(utcOf("2026-06-20T18:02:33-08:00"), "2026-06-21T02:02:33.000Z", "ISO 8601 negative offset");
eq(utcOf("20260620T180233Z"), "2026-06-20T18:02:33.000Z", "ISO 8601 basic");
eq(utcOf("Sat, 20 Jun 2026 18:02:33 GMT"), "2026-06-20T18:02:33.000Z", "RFC 1123 HTTP-date");
eq(utcOf("Sun Nov  6 08:49:37 1994"), "1994-11-06T08:49:37.000Z", "asctime");
eq(utcOf("6:02 PM UTC", { mergeDate: { y: 2026, mo: 5, d: 20 } }), "2026-06-20T18:02:00.000Z", "12h time + merged date");
eq(utcOf("18:02 utc", { mergeDate: { y: 2026, mo: 5, d: 20 } }), "2026-06-20T18:02:00.000Z", "lowercase utc, merged date");
eq(utcOf("2026/06/20 18:02 UTC"), "2026-06-20T18:02:00.000Z", "numeric date + time UTC");
eq(utcOf("Jun 20, 2026, 6:02 PM UTC"), "2026-06-20T18:02:00.000Z", "Mon DD, YYYY, 12h UTC (comma)");
eq(utcOf("January 15, 2026, 09:30 UTC"), "2026-01-15T09:30:00.000Z", "full month + comma before 24h time");
eq(utcOf("12:00 AM UTC", { mergeDate: { y: 2026, mo: 5, d: 20 } }), "2026-06-20T00:00:00.000Z", "12:00 AM -> midnight");
eq(utcOf("12:00 PM UTC", { mergeDate: { y: 2026, mo: 5, d: 20 } }), "2026-06-20T12:00:00.000Z", "12:00 PM -> noon");

// ---------------------------------------------------------------------------
// Negative cases — should NOT convert (rawOf === "NONE", or parse to NULL).
// ---------------------------------------------------------------------------
eq(rawOf("aspect ratio 16:9"), "NONE", "aspect ratio not a time");
eq(rawOf("the score was 3:2"), "NONE", "score not a time");
eq(rawOf("14:30 GMT+5 webinar"), "NONE", "offset-bearing GMT+5 must not convert as pure UTC");
eq(rawOf("09:00 UTC-7 call"), "NONE", "offset-bearing UTC-7 must not convert");
eq(rawOf("meeting at 18:02 EST"), "NONE", "non-UTC zone EST");
eq(rawOf("6:02 PM CET"), "NONE", "non-UTC zone CET");
eq(rawOf("v1.2.3 release"), "NONE", "version number");
eq(rawOf("only 5:00 remaining"), "NONE", "duration with 'remaining'");
eq(rawOf("starts in 18:02"), "NONE", "duration with preposition 'in'");
// "Marathon" must not be parsed as a month; the bare trailing time can't anchor.
eq(utcOf("Marathon 5, 2020 12:00 UTC"), "NULL", "month-word false positive yields no concrete instant");
// Impossible dates rejected by round-trip validation.
eq(utcOf("Feb 30, 2026 10:00 UTC"), "NULL", "Feb 30 rejected");
eq(utcOf("2026-06-31T10:00:00Z"), "NULL", "Jun 31 matches generic day class but round-trip-rejected to null");
// Out-of-range offset rejected.
eq(utcOf("2026-06-20T18:02:33+99:99"), "NONE", "absurd offset rejected by regex");

// ---------------------------------------------------------------------------
// Multiple matches in one string.
// ---------------------------------------------------------------------------
(function () {
  var ms = UtcParser.findMatches("Open 09:00 UTC to 17:00 UTC daily");
  eq(ms.length, 2, "range yields two independent matches");
})();

// ---------------------------------------------------------------------------
// formatLocal basic shape (timezone-independent assertions).
// ---------------------------------------------------------------------------
(function () {
  var d = new Date(Date.UTC(2026, 5, 20, 18, 2, 0));
  var s24 = UtcParser.formatLocal(d, { hourFormat: "24", showDate: false, showZone: false });
  eq(/^\d{2}:\d{2}$/.test(s24), true, "24h time-only format shape (" + s24 + ")");
  var s12 = UtcParser.formatLocal(d, { hourFormat: "12", showDate: false, showZone: false });
  eq(/\d{1,2}:\d{2}\s?(AM|PM)/i.test(s12), true, "12h time-only format shape (" + s12 + ")");
  eq(UtcParser.formatLocal("not a date", {}), "", "formatLocal rejects non-Date");
})();

// ---------------------------------------------------------------------------
// parseDateContext (sibling split-node date half).
// ---------------------------------------------------------------------------
(function () {
  eq(JSON.stringify(UtcParser.parseDateContext("Jun 22, 2026")), JSON.stringify({ mo: 5, d: 22, y: 2026 }), "parseDateContext Mon DD, YYYY");
  eq(JSON.stringify(UtcParser.parseDateContext("Jun 22")), JSON.stringify({ mo: 5, d: 22 }), "parseDateContext Mon DD (no year)");
  eq(UtcParser.parseDateContext("nothing here"), null, "parseDateContext no date -> null");
})();

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log("\nPASS: " + passed + "   FAIL: " + failed);
if (failed) {
  console.log("\nFailures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
