/**
 * UtcParser — pure, DOM-free, classic-script-compatible UTC timestamp engine.
 *
 * Public API (attached to the UtcParser namespace object):
 *   findMatches(text)            -> Array<{index, length, raw, fields}>
 *   parseToUtcDate(fields, opts) -> Date | null   (built via Date.UTC)
 *   formatLocal(date, opts)      -> string
 *   parseDateContext(text)       -> {y?, mo, d} | null   (sibling-node date half)
 *   monthNameToIndex(name)       -> 0-11 | -1
 *
 * Design constraints honored here:
 *   - No DOM access.
 *   - No ES import/export (classic script). Namespace via IIFE.
 *   - No Date.now(), no argless `new Date()`, no Math.random().
 *     Any "now"/reference time must be supplied by the caller via opts.referenceDate.
 *   - Deterministic field extraction; we NEVER call Date.parse / new Date(string)
 *     on matched text. We always build instants from explicit UTC components.
 *   - Regexes are anchored by mandatory literals and avoid nested quantifiers
 *     over overlapping classes, so they are linear (no catastrophic backtracking).
 *
 * Range / per-time annotation policy (re: the "time ranges" finding): this
 * engine intentionally emits one independent, self-describing match per
 * timestamp. Range awareness (e.g. "09:00 UTC to 17:00 UTC") is a presentation
 * concern for the DOM layer; the parser stays a pure per-instant engine. This is
 * documented rather than "fixed" because per-time annotation is the deliberate
 * design and the only conversion-correct behavior without DOM context.
 */
// NOTE: declared with `var` (not `const`) on purpose. Chrome runs the content
// script's JS files in one shared isolated world; a top-level `var` attaches to
// that world's global object, guaranteeing this symbol is visible to content.js
// (which is listed after this file in the manifest). A top-level `const` lives
// in the lexical global scope, which is also shared, but `var` is the more
// robust, widely-relied-upon mechanism for cross-file content-script sharing.
var UtcParser = (function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Month lookup (lowercased first-3-letters -> 0-11). Used instead of Date.parse
  // so month-name interpretation is locale/impl independent.
  // ---------------------------------------------------------------------------
  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  function monthNameToIndex(name) {
    if (name == null) return -1;
    var key = String(name).slice(0, 3).toLowerCase();
    return Object.prototype.hasOwnProperty.call(MONTHS, key) ? MONTHS[key] : -1;
  }

  // Long weekday names indexed by Date.getUTCDay() (0 = Sunday).
  var WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  function weekdayNameToIndex(name) {
    if (name == null) return -1;
    var key = String(name).slice(0, 3).toLowerCase();
    for (var i = 0; i < WEEKDAYS.length; i++) {
      if (WEEKDAYS[i] === key) return i;
    }
    return -1;
  }

  // A fully-spelled month-name alternation, with optional abbreviation. This
  // replaces the previous `(Jan|...|Dec)[a-z]*` shape, which let ordinary words
  // that merely START with a month abbreviation (e.g. "Marathon", "Maybe",
  // "Junkyard", "Septic") match and parse with a wrong month. Now the trailing
  // letters must form an actual month-name completion, and the abbreviation is
  // followed (in the formats) by a non-letter boundary.
  var MONTH_NAME =
    "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|" +
    "Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

  // ---------------------------------------------------------------------------
  // Cross-realm-safe Date check. `instanceof Date` fails for Dates created in
  // another JS realm (iframe / vm context); a content script may legitimately
  // receive such Dates across frames. Use the brand tag instead.
  // ---------------------------------------------------------------------------
  function isValidDate(x) {
    return Object.prototype.toString.call(x) === "[object Date]" &&
      !isNaN(x.getTime());
  }

  // ---------------------------------------------------------------------------
  // Timezone abbreviations that are explicitly NOT UTC. (Kept for defensiveness;
  // the format regexes already only consume UTC/GMT/Z, and a trailing numeric
  // offset is now rejected by both regex lookahead and an isVetoed guard.)
  // ---------------------------------------------------------------------------
  var NON_UTC_ZONE_RE =
    /^(EST|EDT|CST|CDT|MST|MDT|PST|PDT|CET|CEST|EET|EEST|WET|WEST|BST|IST|JST|KST|AEST|AEDT|ACST|AWST|HKT|SGT|MSK|NZST|NZDT|AKST|AKDT|HST|CHST|ART|BRT|CLT|COT|PET|VET|GST|PKT|WIB|WITA|WIT|PHT|MYT|EAT|SAST|WAT|CAT|NPT|local)\b/i;

  // Words that, when preceding a HH:MM, indicate a duration / countdown / non-time.
  var DURATION_PREP_RE = /(?:^|[\s(])(in|for|after|within|every|before|until|till|over|elapsed|remaining|left|ago)\s*$/i;

  // Trailing-context words that indicate ratios / aspect / scale / odds.
  var RATIO_TRAIL_RE = /^\s*(scale|odds|ratio|aspect|remaining|elapsed|left)\b/i;

  // A numeric UTC offset that may follow a UTC/GMT token ("UTC+5", "GMT -8",
  // "GMT+05:30"). If present, the candidate is NOT pure UTC and must be vetoed.
  // Allows leading spaces before the sign so the spaced variant ("GMT +1") is
  // caught. Covers ASCII '+'/'-' and the Unicode minus sign U+2212. The offset
  // value is constrained to an offset SHAPE (1-2 digit hour, optional ':MM' or
  // 'MM') so a directly-attached digit run is treated as an offset.
  var TRAILING_NUMERIC_OFFSET_RE = /^\s*[+−-]\s*\d{1,2}(?::?\d{2})?\b/;

  // A range-endpoint shape: a '-'/'–'/'—'/'−' (or 'to'/'through'/'until' word)
  // followed by another HH:MM that is itself a time (typically with its own
  // zone). This is NOT an offset; e.g. "09:00 UTC - 17:00 UTC". When `after`
  // matches this, the trailing-offset veto must NOT fire. Note a real offset is
  // at most HH:MM and would not be followed by a second ':' or a zone word, so
  // the explicit ':MM' + trailing context here disambiguates cleanly.
  var TRAILING_RANGE_RE =
    /^\s*(?:[-–—−]|to|through|until|thru)\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|[AaPp]\.?[Mm]|$|[A-Za-z])/i;

  // ---------------------------------------------------------------------------
  // Numeric helpers.
  // ---------------------------------------------------------------------------
  function toInt(v, dflt) {
    if (v == null || v === "") return dflt;
    var n = parseInt(v, 10);
    return isNaN(n) ? dflt : n;
  }

  function fracToMs(frac) {
    if (frac == null || frac === "") return 0;
    // First 3 digits, right-padded, as milliseconds.
    var s = (frac + "000").slice(0, 3);
    return toInt(s, 0);
  }

  function meridiemTo24(hour12, meridiem) {
    var h = hour12;
    var m = String(meridiem || "").replace(/\./g, "").toLowerCase();
    if (m === "pm" && h !== 12) h += 12;
    else if (m === "am" && h === 12) h = 0;
    return h;
  }

  // 2-digit-year window (POSIX strptime convention): 00-68 -> 2000-2068,
  // 69-99 -> 1969-1999.
  function expand2DigitYear(yy) {
    return yy <= 68 ? 2000 + yy : 1900 + yy;
  }

  // Maximum real-world UTC offset magnitude is +14:00 (IANA). ISO minutes 0-59.
  var MAX_OFFSET_MINUTES = 14 * 60;

  // Re-usable regex fragments (interpolated below). The offset / zone shape is
  // defined once here so it stays consistent across formats.
  //   ISO_OFFSET: sign + bounded hours (00-14) + minutes (00-59), ':' optional.
  //   ZONE_UTC:   UTC/GMT with a negative lookahead so a directly-attached
  //               numeric offset (UTC+5, GMT-8) disqualifies the match.
  var ISO_OFFSET = "([+\\u2212-])(0\\d|1[0-4]):?([0-5]\\d)";
  var ZONE_UTC = "(?:UTC|GMT)(?![+\\u2212\\-\\d])\\b";

  function rx(source, extraFlags) {
    return new RegExp(source, "g" + (extraFlags || ""));
  }

  function offsetSign(ch) {
    return (ch === "-" || ch === "−") ? -1 : 1;
  }

  // ---------------------------------------------------------------------------
  // Format definitions. ORDER MATTERS: longest / most specific first so a
  // superset format consumes the text before a subset can partial-match.
  //
  // Each entry: { name, re (global, case-insensitive), build(m) -> fields|null }
  //
  // Conventions baked into every zone-bearing regex:
  //   - `i` flag: case-insensitive month / weekday / UTC / GMT / Z / am-pm.
  //   - ZONE_UTC negative lookahead blocks a directly-attached numeric offset.
  //   - Zulu `Z` (no sign in the surrounding class) plus the isVetoed guard
  //     block spaced numeric offsets.
  //   - Fractional seconds accept BOTH '.' and ',' (ISO 8601 allows comma).
  //   - Time-only forms use a `(?<![\d:])` left lookbehind so a valid time
  //     cannot be carved out of an invalid prefix (e.g. "24:00:00 UTC").
  //
  // `fields` is a normalized object consumed by parseToUtcDate. Discriminated:
  //   kind: "absolute"  -> y/mo/d/h/mi/s/ms and either utc:true or offset.
  //   kind: "dateless"  -> h/mi/s/ms only; year+month+day inferred/merged.
  // ---------------------------------------------------------------------------
  var FORMATS = [
    // 1) ISO 8601 with numeric offset (run before Zulu so the offset isn't lost).
    //    Offset bounded to +/-14:00, minutes 0-59; lowercase 't' allowed; the
    //    fractional separator may be '.' or ','.
    {
      name: "ISO 8601 with numeric offset",
      re: rx(
        "\\b(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])[Tt ]" +
        "([01]\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d)(?:[.,](\\d{1,9}))?)?" +
        ISO_OFFSET + "\\b",
        "i"
      ),
      build: function (m) {
        var offsetMinutes = offsetSign(m[8]) * (toInt(m[9]) * 60 + toInt(m[10]));
        // Defense-in-depth: regex already bounds these, but guard anyway.
        if (Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) return null;
        return {
          kind: "absolute",
          y: toInt(m[1]), mo: toInt(m[2]) - 1, d: toInt(m[3]),
          h: toInt(m[4]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: fracToMs(m[7]),
          utc: false,
          offsetMinutes: offsetMinutes,
          hasSeconds: m[6] != null && m[6] !== "",
          requiresValidation: true
        };
      }
    },

    // 2) ISO 8601 UTC (Zulu). Lowercase 't'/'z' allowed; ',' fractional allowed.
    {
      name: "ISO 8601 UTC (Zulu)",
      re: rx(
        "\\b(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])[Tt ]" +
        "([01]\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d)(?:[.,](\\d{1,9}))?)?Z\\b",
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: toInt(m[1]), mo: toInt(m[2]) - 1, d: toInt(m[3]),
          h: toInt(m[4]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: fracToMs(m[7]),
          utc: true, offsetMinutes: 0,
          hasSeconds: m[6] != null && m[6] !== "",
          requiresValidation: true
        };
      }
    },

    // 3) ISO 8601 basic format (no separators), Zulu or numeric offset.
    //    e.g. 20210304T102030Z, 20210304T102030+0530.
    {
      name: "ISO 8601 basic",
      re: rx(
        "\\b(\\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])[Tt]" +
        "([01]\\d|2[0-3])([0-5]\\d)(?:([0-5]\\d)(?:[.,](\\d{1,9}))?)?" +
        "(?:Z|([+\\u2212-])(0\\d|1[0-4])([0-5]\\d))\\b",
        "i"
      ),
      build: function (m) {
        var utc = (m[8] == null || m[8] === "");
        var offsetMinutes = 0;
        if (!utc) {
          offsetMinutes = offsetSign(m[8]) * (toInt(m[9]) * 60 + toInt(m[10]));
          if (Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) return null;
        }
        return {
          kind: "absolute",
          y: toInt(m[1]), mo: toInt(m[2]) - 1, d: toInt(m[3]),
          h: toInt(m[4]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: fracToMs(m[7]),
          utc: utc, offsetMinutes: offsetMinutes,
          hasSeconds: m[6] != null && m[6] !== "",
          requiresValidation: true
        };
      }
    },

    // 4) RFC 1123 / HTTP-date (DD Mon YYYY HH:MM:SS GMT). Weekday, if present,
    //    is validated against the date in parseToUtcDate via wantWeekday.
    {
      name: "RFC 1123 / HTTP-date",
      re: rx(
        "\\b(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\\s+)?" +
        "(0?[1-9]|[12]\\d|3[01])\\s+" + MONTH_NAME + "\\s+(\\d{4})\\s+" +
        "([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)\\s+(?:GMT|UTC)\\b",
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: toInt(m[4]), mo: monthNameToIndex(m[3]), d: toInt(m[2]),
          h: toInt(m[5]), mi: toInt(m[6]), s: toInt(m[7], 0), ms: 0,
          utc: true, offsetMinutes: 0, hasSeconds: true,
          wantWeekday: weekdayNameToIndex(m[1]),
          requiresValidation: true
        };
      }
    },

    // 5) RFC 850 / long weekday, 2-digit year. Weekday validated in parse.
    {
      name: "RFC 850",
      re: rx(
        "\\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,\\s+" +
        "(0?[1-9]|[12]\\d|3[01])-" + MONTH_NAME + "-(\\d{2})\\s+" +
        "([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)\\s+(?:GMT|UTC)\\b",
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: expand2DigitYear(toInt(m[4])), mo: monthNameToIndex(m[3]), d: toInt(m[2]),
          h: toInt(m[5]), mi: toInt(m[6]), s: toInt(m[7], 0), ms: 0,
          utc: true, offsetMinutes: 0, hasSeconds: true,
          wantWeekday: weekdayNameToIndex(m[1]),
          requiresValidation: true
        };
      }
    },

    // 6) asctime-style date (RFC 7231's third HTTP-date form), canonically GMT.
    //    e.g. "Sun Nov  6 08:49:37 1994" (note the run of spaces before a
    //    1-digit day). Weekday validated in parse. The mandatory weekday +
    //    HH:MM:SS + 4-digit year shape keeps false positives low even though
    //    there is no UTC/GMT token.
    {
      name: "asctime",
      re: rx(
        "\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+" + MONTH_NAME + "\\s+" +
        "(0?[1-9]|[12]\\d|3[01])\\s+" +
        "([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)\\s+(\\d{4})\\b",
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: toInt(m[7]), mo: monthNameToIndex(m[2]), d: toInt(m[3]),
          h: toInt(m[4]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: 0,
          utc: true, offsetMinutes: 0, hasSeconds: true,
          wantWeekday: weekdayNameToIndex(m[1]),
          requiresValidation: true
        };
      }
    },

    // 7) Month-Day-Year + 12h time + UTC. Dotted meridiem ('a.m.') accepted.
    {
      name: "Month-Day-Year + 12h time + UTC",
      re: rx(
        "\\b" + MONTH_NAME + "\\.?\\s+(0?[1-9]|[12]\\d|3[01]),?\\s+(\\d{4}),?\\s+" +
        "(0?[1-9]|1[0-2]):([0-5]\\d)(?::([0-5]\\d))?\\s?([AaPp])\\.?\\s?([Mm])\\.?\\s?" +
        ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: toInt(m[3]), mo: monthNameToIndex(m[1]), d: toInt(m[2]),
          h: meridiemTo24(toInt(m[4]), m[7] + m[8]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: 0,
          utc: true, offsetMinutes: 0,
          hasSeconds: m[6] != null && m[6] !== "",
          requiresValidation: true
        };
      }
    },

    // 8) Month-Day-Year + 24h time + UTC (optional comma and/or '-'/en-dash).
    //    Comma before the time is now permitted (parity with the 12h sibling),
    //    fixing the silent "wrong date via mergeDate" bug for human/CMS styles.
    {
      name: "Month-Day-Year + time + UTC",
      re: rx(
        "\\b" + MONTH_NAME + "\\.?\\s+(0?[1-9]|[12]\\d|3[01]),?\\s+(\\d{4})\\s*,?\\s*[-\\u2013]?\\s*" +
        "([01]?\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d))?\\s?" + ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: toInt(m[3]), mo: monthNameToIndex(m[1]), d: toInt(m[2]),
          h: toInt(m[4]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: 0,
          utc: true, offsetMinutes: 0,
          hasSeconds: m[6] != null && m[6] !== "",
          requiresValidation: true
        };
      }
    },

    // 9) Numeric date + time + UTC (YYYY/MM/DD or YYYY-MM-DD, year-first only).
    {
      name: "Numeric date + time + UTC",
      re: rx(
        "\\b(\\d{4})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\\d|3[01])\\s+" +
        "([01]\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d))?\\s?" + ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "absolute",
          y: toInt(m[1]), mo: toInt(m[2]) - 1, d: toInt(m[3]),
          h: toInt(m[4]), mi: toInt(m[5]), s: toInt(m[6], 0), ms: 0,
          utc: true, offsetMinutes: 0,
          hasSeconds: m[6] != null && m[6] !== "",
          requiresValidation: true
        };
      }
    },

    // 10) Month-Day + time + UTC, no year (the status-page split-node case).
    {
      name: "Month-Day + time + UTC (no year)",
      re: rx(
        "\\b" + MONTH_NAME + "\\.?\\s+(0?[1-9]|[12]\\d|3[01]),?\\s+" +
        "([01]?\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d))?\\s?" + ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "dateless",
          haveMonthDay: true,
          mo: monthNameToIndex(m[1]), d: toInt(m[2]),
          h: toInt(m[3]), mi: toInt(m[4]), s: toInt(m[5], 0), ms: 0,
          utc: true, offsetMinutes: 0,
          hasSeconds: m[5] != null && m[5] !== "",
          requiresValidation: true
        };
      }
    },

    // 11) 12-hour time with am/pm + UTC (time-only). Dotted meridiem accepted.
    {
      name: "12-hour time + UTC",
      re: rx(
        "(?<![\\d:])(0?[1-9]|1[0-2]):([0-5]\\d)(?::([0-5]\\d))?\\s?" +
        "([AaPp])\\.?\\s?([Mm])\\.?\\s?" + ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "dateless",
          haveMonthDay: false,
          h: meridiemTo24(toInt(m[1]), m[4] + m[5]), mi: toInt(m[2]), s: toInt(m[3], 0), ms: 0,
          utc: true, offsetMinutes: 0,
          hasSeconds: m[3] != null && m[3] !== "",
          timeOnly: true,
          requiresValidation: true
        };
      }
    },

    // 12) Time-only with seconds + UTC/GMT (HH:MM:SS). Before HH:MM variant.
    //     Single-digit hour allowed; the left lookbehind blocks carving a valid
    //     time out of an invalid one (e.g. "24:00:00 UTC").
    {
      name: "Time-only HH:MM:SS + UTC",
      re: rx(
        "(?<![\\d:])([01]?\\d|2[0-3]):([0-5]\\d):([0-5]\\d)\\s?" + ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "dateless",
          haveMonthDay: false,
          h: toInt(m[1]), mi: toInt(m[2]), s: toInt(m[3], 0), ms: 0,
          utc: true, offsetMinutes: 0, hasSeconds: true,
          timeOnly: true,
          requiresValidation: true
        };
      }
    },

    // 13) Time-only with UTC/GMT (HH:MM). Single-digit hour allowed.
    {
      name: "Time-only HH:MM + UTC",
      re: rx(
        "(?<![\\d:])([01]?\\d|2[0-3]):([0-5]\\d)\\s?" + ZONE_UTC,
        "i"
      ),
      build: function (m) {
        return {
          kind: "dateless",
          haveMonthDay: false,
          h: toInt(m[1]), mi: toInt(m[2]), s: 0, ms: 0,
          utc: true, offsetMinutes: 0, hasSeconds: false,
          timeOnly: true,
          requiresValidation: true
        };
      }
    }
  ];

  // ---------------------------------------------------------------------------
  // parseDateContext(text): extract a bare date half ("Jun 22", "Jun 22 2026",
  // "Jun 22, 2026", "2026-06-22") with NO time/zone, for use as opts.mergeDate
  // on a sibling split node. Returns {y?, mo, d} | null. `y` is omitted when the
  // source carries no year (caller then relies on inferYear). This lets the DOM
  // layer feed a sibling node straight into mergeDate without re-implementing
  // month logic.
  // ---------------------------------------------------------------------------
  var DATE_CONTEXT_FORMATS = [
    {
      // "YYYY-MM-DD" / "YYYY/MM/DD" (year-first, most specific -> first).
      re: new RegExp(
        "\\b(\\d{4})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\\d|3[01])\\b",
        "i"
      ),
      build: function (m) {
        return { y: toInt(m[1]), mo: toInt(m[2]) - 1, d: toInt(m[3]) };
      }
    },
    {
      // "Mon DD, YYYY" / "Mon DD YYYY" / "Mon DD"
      re: new RegExp(
        "\\b" + MONTH_NAME + "\\.?\\s+(0?[1-9]|[12]\\d|3[01])(?:,?\\s+(\\d{4}))?\\b",
        "i"
      ),
      build: function (m) {
        var out = { mo: monthNameToIndex(m[1]), d: toInt(m[2]) };
        if (m[3] != null && m[3] !== "") out.y = toInt(m[3]);
        return out;
      }
    }
  ];

  function parseDateContext(text) {
    if (typeof text !== "string" || text.length === 0) return null;
    for (var i = 0; i < DATE_CONTEXT_FORMATS.length; i++) {
      var f = DATE_CONTEXT_FORMATS[i];
      var m = f.re.exec(text);
      if (m) {
        var out = f.build(m);
        if (out && out.mo >= 0 && out.mo <= 11 && out.d >= 1 && out.d <= 31) {
          return out;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // False-positive vetoes applied to a candidate match given its surrounding
  // text. Returns true if the match should be REJECTED.
  // ---------------------------------------------------------------------------
  function isVetoed(fields, text, start, end) {
    var before = text.slice(Math.max(0, start - 24), start);
    var after = text.slice(end, Math.min(text.length, end + 24));

    // Money typo guard: '$18:02 ...' — a '$' immediately before a time-only form.
    if (fields.timeOnly && /\$\s*$/.test(before)) return true;

    // Duration / countdown preposition before a time-only form.
    if (fields.timeOnly && DURATION_PREP_RE.test(before)) return true;

    // Ratio / aspect / scale / odds trailing word right after the match.
    if (RATIO_TRAIL_RE.test(after)) return true;

    // Coordinates: a cardinal direction immediately following (e.g. '18:02:33N').
    if (/^[NSEW]\b/.test(after)) return true;

    // A numeric offset following the UTC/GMT token, possibly space-separated
    // ("14:30 GMT +5", "09:00 UTC - 7"). The no-space case is already blocked by
    // the ZONE_UTC lookahead; this catches the spaced variant. Without it the
    // engine would silently treat an offset-bearing zone as pure UTC and emit a
    // wrong local time. We must NOT confuse this with a range endpoint
    // ("09:00 UTC - 17:00 UTC"), so a range shape suppresses the veto.
    if (TRAILING_NUMERIC_OFFSET_RE.test(after) && !TRAILING_RANGE_RE.test(after)) {
      return true;
    }

    // A non-UTC timezone abbreviation appearing right after a consumed UTC token.
    var trimmedAfter = after.replace(/^[\s,/-]+/, "");
    if (NON_UTC_ZONE_RE.test(trimmedAfter)) return true;

    return false;
  }

  // ---------------------------------------------------------------------------
  // findMatches(text): ordered, non-overlapping matches across all formats.
  // ---------------------------------------------------------------------------
  function findMatches(text) {
    if (typeof text !== "string" || text.length === 0) return [];

    // PHASE 1 — cheap candidate gate. If none of the anchor shapes is present,
    // bail immediately (the key perf lever on large/non-date pages). Now
    // case-insensitive (lowercase utc/gmt/z were previously missed), and also
    // admits asctime ("Mon Nov  6 ... 1994"), which carries no zone token, via
    // a weekday probe.
    var lower = text.toLowerCase();
    if (
      lower.indexOf("utc") === -1 &&
      lower.indexOf("gmt") === -1 &&
      !/\d{4}-?\d\d-?\d\d/.test(text) &&
      !/\dz\b/i.test(text) &&
      !/\b(?:mon|tue|wed|thu|fri|sat|sun)\b/i.test(lower)
    ) {
      return [];
    }

    var raw = [];
    for (var fi = 0; fi < FORMATS.length; fi++) {
      var fmt = FORMATS[fi];
      fmt.re.lastIndex = 0;
      var m;
      while ((m = fmt.re.exec(text)) !== null) {
        // Zero-length guard. Defensive only: every format begins with mandatory
        // literal/digit content (lookbehinds consume nothing but are followed by
        // such content), so a zero-length match cannot occur with the current
        // regex set. Kept to guarantee loop termination regardless of future
        // edits; `continue` avoids re-running build() on a zero-length artifact.
        if (m.index === fmt.re.lastIndex) {
          fmt.re.lastIndex++;
          continue;
        }

        var start = m.index;
        var end = m.index + m[0].length;
        var fields = fmt.build(m);
        if (!fields) continue;
        fields.name = fmt.name;

        if (isVetoed(fields, text, start, end)) continue;

        raw.push({ index: start, length: m[0].length, raw: m[0], fields: fields, _fi: fi });
      }
    }

    if (raw.length === 0) return [];

    // Resolve overlaps with longest-match-first preference. Sort by start asc,
    // then by length desc, then by format priority (earlier format = more
    // specific) asc.
    raw.sort(function (a, b) {
      if (a.index !== b.index) return a.index - b.index;
      if (a.length !== b.length) return b.length - a.length;
      return a._fi - b._fi;
    });

    var out = [];
    var consumedTo = -1;
    for (var i = 0; i < raw.length; i++) {
      var cand = raw[i];
      if (cand.index < consumedTo) continue; // overlaps an already-accepted match
      out.push({ index: cand.index, length: cand.length, raw: cand.raw, fields: cand.fields });
      consumedTo = cand.index + cand.length;
    }

    out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Year inference. Given month/day/time fields with no year and a UTC
  // referenceDate, pick the year so the instant lands in the recent past,
  // allowing a small forward tolerance for scheduled near-future notices.
  //
  // Returns null when NO valid candidate year exists at all (no fix for an
  // impossible month/day). For a normally-valid month/day this still returns a
  // year. Feb 29 widens the search outward to nearby leap years so a leap-day
  // timestamp can resolve even when the reference year and its immediate
  // neighbors are non-leap.
  // ---------------------------------------------------------------------------
  function inferYear(mo, d, h, mi, s, ms, referenceDate, toleranceMs) {
    var refMs = referenceDate.getTime();
    var refYear = referenceDate.getUTCFullYear();
    var tol = (typeof toleranceMs === "number") ? toleranceMs : 48 * 3600 * 1000;

    // Default window: prev/this/next year. For Feb 29 widen outward so a valid
    // leap year can always be found even when the immediate neighbors are not
    // leap years (e.g. ref 2026 -> reach 2024 / 2028).
    var span = (mo === 1 && d === 29) ? 4 : 1;
    var candidates = [refYear];
    for (var off = 1; off <= span; off++) {
      candidates.push(refYear - off);
      candidates.push(refYear + off);
    }

    var best = null;     // best ACCEPTABLE candidate (past, or within tolerance)
    var fallback = null; // best VALID candidate overall if none is acceptable

    for (var i = 0; i < candidates.length; i++) {
      var y = candidates[i];
      var epoch = Date.UTC(y, mo, d, h, mi, s, ms);
      // Reject impossible field combos (e.g. Feb 29 on a non-leap year):
      var probe = new Date(epoch);
      if (probe.getUTCMonth() !== mo || probe.getUTCDate() !== d) continue;

      var delta = epoch - refMs;             // >0 means future
      var dist = delta < 0 ? -delta : delta; // distance from reference

      // Track a valid fallback (closest to reference) in case none is acceptable.
      if (fallback === null || dist < fallback.dist) {
        fallback = { year: y, dist: dist };
      }

      // "Acceptable" = in the past, or no more than `tol` into the future.
      // Among acceptable candidates, prefer the one CLOSEST to the reference.
      // This favors a near-future in-tolerance timestamp (e.g. scheduled
      // "Jun 22" read on "Jun 21") over a ~1-year-old past candidate, while
      // still rejecting far-future readings.
      if (delta <= tol) {
        if (best === null || dist < best.dist) {
          best = { year: y, dist: dist };
        }
      }
    }

    if (best) return best.year;
    // No acceptable (past / in-tolerance) candidate. If a valid-but-far year
    // exists (e.g. an only-in-the-future leap day relative to the reference),
    // surface it so the date can still be converted; the round-trip check in
    // parseToUtcDate will accept it since it is a real calendar date.
    if (fallback) return fallback.year;
    return null;
  }

  // ---------------------------------------------------------------------------
  // parseToUtcDate(fields, opts) -> Date | null
  //
  // opts:
  //   referenceDate   : Date   (REQUIRED for dateless/year-less inference)
  //   mergeDate       : {y, mo, d}  explicit date from a sibling node/context
  //   yearToleranceMs : number  forward tolerance for year inference
  //
  // Returns a Date built purely from Date.UTC, or null if the fields are
  // invalid / cannot be resolved.
  // ---------------------------------------------------------------------------
  function parseToUtcDate(fields, opts) {
    if (!fields || typeof fields !== "object") return null;
    opts = opts || {};

    var y, mo, d, h, mi, s, ms;
    h = fields.h; mi = fields.mi; s = fields.s || 0; ms = fields.ms || 0;

    // Basic time sanity (defensive; regex classes already bound these).
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59) || !(s >= 0 && s <= 59)) {
      return null;
    }

    // Defense-in-depth offset guard for direct callers passing hand-built fields
    // (the format builders already bound the offset and reject out-of-range).
    if (fields.utc === false) {
      if (typeof fields.offsetMinutes !== "number" ||
          isNaN(fields.offsetMinutes) ||
          Math.abs(fields.offsetMinutes) > MAX_OFFSET_MINUTES) {
        return null;
      }
    }

    if (fields.kind === "absolute") {
      y = fields.y; mo = fields.mo; d = fields.d;
      if (mo < 0 || mo > 11) return null;
    } else {
      // dateless: need a month/day (match or merge) and a year (merge or infer).
      var mergeDate = opts.mergeDate || null;

      if (fields.haveMonthDay) {
        mo = fields.mo; d = fields.d;
      } else if (mergeDate && mergeDate.mo != null && mergeDate.d != null) {
        mo = mergeDate.mo; d = mergeDate.d;
      } else if (mergeDate && mergeDate.d != null && mergeDate.mo == null) {
        return null; // partial merge date is unusable
      } else {
        // Pure time-only with no month/day context: cannot build an instant.
        return null;
      }
      if (mo < 0 || mo > 11) return null;

      if (mergeDate && mergeDate.y != null) {
        y = mergeDate.y;
      } else {
        var ref = opts.referenceDate;
        if (!isValidDate(ref)) return null;
        y = inferYear(mo, d, h, mi, s, ms, ref, opts.yearToleranceMs);
        if (y == null) return null; // un-anchorable: treat as parse failure
      }
    }

    // Build the UTC instant. Fields are already UTC for utc:true; for numeric
    // offset, subtract the offset to reach UTC.
    var epoch = Date.UTC(y, mo, d, h, mi, s, ms);
    if (fields.utc === false && typeof fields.offsetMinutes === "number") {
      epoch -= fields.offsetMinutes * 60000;
    }

    var date = new Date(epoch);
    if (isNaN(date.getTime())) return null;

    // Round-trip validation: discard impossible dates (Feb 30, Jun 31) that
    // Date.UTC would have silently rolled over. Validate against the ORIGINAL
    // local-UTC components BEFORE any offset shift.
    var probeEpoch = Date.UTC(y, mo, d, h, mi, s, ms);
    var probe = new Date(probeEpoch);
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== mo ||
      probe.getUTCDate() !== d ||
      probe.getUTCHours() !== h ||
      probe.getUTCMinutes() !== mi ||
      probe.getUTCSeconds() !== s
    ) {
      return null;
    }

    // Weekday validation for HTTP-date / RFC-850 / asctime forms. A named
    // weekday that disagrees with the actual date indicates a malformed/spoofed
    // timestamp; reject rather than confidently converting. Validated against
    // the pre-offset UTC components (these forms are always utc:true anyway).
    if (typeof fields.wantWeekday === "number" && fields.wantWeekday >= 0) {
      if (probe.getUTCDay() !== fields.wantWeekday) return null;
    }

    return date;
  }

  // ---------------------------------------------------------------------------
  // formatLocal(date, opts) -> string in LOCAL time.
  //
  // opts:
  //   hourFormat : "12" | "24" | "auto"   (default "auto")
  //   showZone   : boolean                (append local tz short name)
  //   showDate   : boolean                (include the date portion; default true)
  //   showSeconds: boolean                (include seconds)
  //   locale     : string | string[]      (Intl locale; default runtime)
  //   timeZone   : string                 (override; default resolved local zone)
  // ---------------------------------------------------------------------------
  function formatLocal(date, opts) {
    if (!isValidDate(date)) return "";
    opts = opts || {};

    var hourFormat = opts.hourFormat || "auto";
    var showZone = !!opts.showZone;
    var showDate = opts.showDate !== false; // default true
    var showSeconds = !!opts.showSeconds;
    var locale = opts.locale; // may be undefined -> runtime default

    var hour12;
    if (hourFormat === "12") hour12 = true;
    else if (hourFormat === "24") hour12 = false;
    else hour12 = undefined; // "auto" -> let Intl decide from locale

    var fmtOpts = { hour: "2-digit", minute: "2-digit" };
    if (hour12 !== undefined) fmtOpts.hour12 = hour12;
    if (showSeconds) fmtOpts.second = "2-digit";
    if (showDate) {
      fmtOpts.year = "numeric";
      fmtOpts.month = "short";
      fmtOpts.day = "numeric";
    }
    if (showZone) fmtOpts.timeZoneName = "short";
    if (opts.timeZone) fmtOpts.timeZone = opts.timeZone;

    try {
      return new Intl.DateTimeFormat(locale, fmtOpts).format(date);
    } catch (e) {
      // Defensive fallback if Intl rejects the options/timezone.
      return localFallback(date, hour12, showDate, showSeconds);
    }
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function localFallback(date, hour12, showDate, showSeconds) {
    var h = date.getHours();
    var suffix = "";
    if (hour12 === true) {
      suffix = h >= 12 ? " PM" : " AM";
      h = h % 12; if (h === 0) h = 12;
    }
    var t = pad2(h) + ":" + pad2(date.getMinutes());
    if (showSeconds) t += ":" + pad2(date.getSeconds());
    t += suffix;
    if (showDate) {
      var monNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return monNames[date.getMonth()] + " " + date.getDate() + ", " +
             date.getFullYear() + ", " + t;
    }
    return t;
  }

  return {
    findMatches: findMatches,
    parseToUtcDate: parseToUtcDate,
    formatLocal: formatLocal,
    parseDateContext: parseDateContext,
    monthNameToIndex: monthNameToIndex,
    // Back-compat aliases (previously underscore-prefixed "for testing"):
    _monthNameToIndex: monthNameToIndex,
    _inferYear: inferYear,
    _isValidDate: isValidDate
  };
})();

// Node/CommonJS export shim ONLY (harmless in a classic browser script: the
// `typeof module` guard short-circuits when `module` is undefined). This keeps
// the file unit-testable without adding ES import/export syntax.
if (typeof module !== "undefined" && module.exports) {
  module.exports = UtcParser;
}
