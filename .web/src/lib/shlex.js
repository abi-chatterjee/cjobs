"use strict";

// A faithful port of Python's `shlex.split(text, comments=True)` in POSIX mode
// with whitespace_split=True (which is exactly how cjob's `_split_value` calls
// it). Mirrors CPython's shlex.py state machine rather than approximating with
// a single regex, since the exact quoting/escaping/comment rules matter for
// values like ALLOWED_TOOLS="Bash(git log:*)" and inline "# comment" suffixes.
//
// Rules replicated:
//  - Outside quotes, a backslash escapes exactly the next character (any
//    character, including whitespace, '#', or a quote) and is itself dropped.
//  - Inside single quotes, everything is literal — no escaping at all.
//  - Inside double quotes, a backslash only escapes a following backslash or
//    double-quote (consuming the backslash); for any other following
//    character the backslash is preserved literally alongside it.
//  - '#' outside any quote starts a comment that runs to the end of the
//    current line (not the whole buffer — matters for multi-line bash-array
//    values), then parsing resumes on the next line.
//  - A quote does not need to start a fresh token — `foo"bar baz"qux` is one
//    token, `foobar bazqux`.
//  - An empty quoted string ("" or '') still yields a token (the empty
//    string), because "was quoted" counts as having a token even if empty.
//  - An unterminated quote or a trailing lone backslash raises, matching
//    Python's ValueError("No closing quotation") / ValueError("No escaped
//    character").

class ShlexError extends Error {}

function shlexSplit(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let token = null; // null = "not currently accumulating a token"

  const startIfNeeded = () => {
    if (token === null) token = "";
  };

  while (i < n) {
    const c = text[i];

    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      if (token !== null) {
        tokens.push(token);
        token = null;
      }
      i++;
      continue;
    }

    if (c === "#") {
      if (token !== null) {
        tokens.push(token);
        token = null;
      }
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    if (c === '"' || c === "'") {
      const quote = c;
      startIfNeeded();
      i++;
      let closed = false;
      while (i < n) {
        const ch = text[i];
        if (ch === quote) {
          closed = true;
          i++;
          break;
        }
        if (quote === '"' && ch === "\\") {
          if (i + 1 < n && (text[i + 1] === '"' || text[i + 1] === "\\")) {
            token += text[i + 1];
            i += 2;
            continue;
          }
          if (i + 1 < n) {
            token += "\\" + text[i + 1];
            i += 2;
            continue;
          }
          // trailing backslash with nothing after it, still inside the quote
          token += "\\";
          i++;
          continue;
        }
        token += ch;
        i++;
      }
      if (!closed) throw new ShlexError("No closing quotation");
      continue;
    }

    if (c === "\\") {
      startIfNeeded();
      if (i + 1 >= n) throw new ShlexError("No escaped character");
      token += text[i + 1];
      i += 2;
      continue;
    }

    startIfNeeded();
    token += c;
    i++;
  }

  if (token !== null) tokens.push(token);
  return tokens;
}

/** Mirrors cjob's `_split_value`: falls back to a single raw-trimmed token on
 * any shlex error, never throws. */
function splitValue(text) {
  try {
    return shlexSplit(text);
  } catch (e) {
    if (e instanceof ShlexError) return [String(text).trim()];
    throw e;
  }
}

module.exports = { shlexSplit, splitValue, ShlexError };
