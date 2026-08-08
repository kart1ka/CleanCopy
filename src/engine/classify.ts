import type { Block, Classification } from './types';

// Step 3 of the pipeline: judge each block.
//
// Two tiers, by design:
//   1. Hard guards — strong structural facts that force "leave it alone".
//   2. A softer prose check, with a confidence score.
// The cost of mistakes is asymmetric (mangling code is far worse than failing
// to tidy prose), so anything uncertain falls through to "verbatim".
//
// THIS FILE IS THE HEART OF THE PRODUCT. Tune it against real fixtures, and
// keep the bias toward never reflowing code/logs/tables.

/**
 * A line that starts a bullet or numbered list item. The single source of
 * truth for "list-ness": normalize (keep an indented fragment's margin),
 * classify (judge a block a list), and transform (find item starts during
 * reflow) all import this one regex — three drifting copies would let a
 * block classify as a list whose items the reflow can no longer see, gluing
 * sibling bullets together.
 */
export const LIST_ITEM = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)/;

// Lines that use a programming keyword the way code does. A bare keyword at
// the start of a line is deliberately NOT a tell when it is also an ordinary
// English word: a wrapped paragraph puts a random word at the start of every
// line, and "for diagnosing them in seconds" must not freeze a block
// (fixture 25). So English-colliding keywords only count together with the
// syntax real code puts after them; keywords that aren't English words
// (def, elif, fn, impl …) stay standalone tells. (Statements this misses —
// e.g. Python's bare `import os` — usually sit next to lines the other guards
// catch; grow the list from real fixtures.)
const CODE_STATEMENT = new RegExp(
  '^\\s*(?:' +
    [
      /(?:def|elif|fn|func|impl)\b/, // keywords that are not English words
      /(?:if|for|while|switch)\s*\(/, // if (cond) {
      /(?:if|while|for|with|try|except|finally|else)\b.*:\s*$/, // if cond:
      /import\s+[\w.]+(?:\s+as\s+\w+)?\s*$/, // import os.path as p
      /from\s+[\w.]+\s+import\s/, // from os import path
      /(?:const|let|var)\s+[\w$]+\s*=/, // let total =
      /function\s+[\w$]+\s*\(/, // function main(
      /class\s+[\w$]+\s*(?:[:({]|\s(?:extends|implements)\s)/, // class Foo:
      /(?:import|export)\b.*(?:\{|\bfrom\s*['"])/, // import { x } from 'y'
      /export\s+default\b/,
      /(?:public|private|protected)\s+(?:static|final|abstract|void|class)\b/,
    ]
      .map((r) => r.source)
      .join('|') +
    ')',
);
const CODE_SYMBOLS = /[{}\[\]<>;=|\\`]/g;
// A sequence of plain commands often has no prompt or shell punctuation at
// all (`git checkout feature`, `brew update`, ...), so the general code-shape
// guards cannot recognize it. Keep this deliberately conservative: only a
// multi-line block where every line starts with a common command is protected.
const SHELL_COMMAND = new RegExp(
  '^\\s*(?:' +
    [
      'alias', 'aws', 'az', 'brew', 'bun', 'cargo', 'cat', 'cd', 'chmod', 'chown',
      'code', 'cp', 'curl', 'deno', 'docker', 'echo', 'env', 'export', 'find',
      'git', 'gcloud', 'go', 'grep', 'head', 'helm', 'java', 'jq', 'kubectl',
      'less', 'ls', 'make', 'mkdir', 'mv', 'node', 'npm', 'npx', 'open', 'pip',
      'pip3', 'pnpm', 'printf', 'python', 'python3', 'rg', 'rm', 'rsync', 'scp',
      'sed', 'source', 'ssh', 'sudo', 'tail', 'terraform', 'touch', 'unset',
      'which', 'wget', 'yarn',
    ].join('|') +
    ')(?:\\s|$)',
);

export function classify(block: Block): Classification {
  const { lines, text } = block;
  const signals: string[] = [];

  // ---- Tier 1: hard guards. Any hit ⇒ leave the block exactly as it is. ----

  if (lines.some((l) => l.includes('\t'))) {
    return verbatim('code', [...signals, 'contains-tab']);
  }
  if (looksLikeTable(lines)) {
    return verbatim('table', [...signals, 'aligned-columns']);
  }
  if (looksLikeTrace(text)) {
    return verbatim('trace', [...signals, 'error-or-trace']);
  }
  if (looksLikeData(lines)) {
    return verbatim('data', [...signals, 'structured-data']);
  }
  if (looksLikeDiff(lines)) {
    return verbatim('code', [...signals, 'diff-marked']);
  }
  if (looksLikeTokenList(lines)) {
    return verbatim('other', [...signals, 'single-token-lines']);
  }
  if (looksLikeShellCommands(lines)) {
    return verbatim('code', [...signals, 'shell-command-sequence']);
  }
  if (looksLikeCode(lines, text)) {
    return verbatim('code', [...signals, 'code-shaped']);
  }

  // ---- A list is its own thing: reflow within items, keep items separate. ----
  if (LIST_ITEM.test(lines[0] ?? '')) {
    return { type: 'list', reflowable: true, confidence: 0.8, signals: [...signals, 'list-marker'] };
  }

  // ---- Tier 2: is it normal writing? ----
  if (looksLikeProse(text)) {
    return {
      type: 'prose',
      reflowable: true,
      confidence: proseConfidence(lines),
      signals: [...signals, 'reads-like-prose'],
    };
  }

  // ---- Not sure: leave it alone. ----
  return verbatim('other', [...signals, 'uncertain']);
}

function looksLikeShellCommands(lines: string[]): boolean {
  return lines.length >= 2 && lines.every((line) => SHELL_COMMAND.test(line));
}

function verbatim(type: Classification['type'], signals: string[]): Classification {
  return { type, reflowable: false, confidence: 0.9, signals };
}

function looksLikeTable(lines: string[]): boolean {
  if (lines.length < 2) return false;

  // Markdown / ASCII pipe tables.
  const piped = lines.filter((l) => (l.match(/\|/g)?.length ?? 0) >= 1).length;
  if (piped >= 2) return true;

  // Whitespace-aligned columns (e.g. `kubectl get`, `ps`, `ls -l`, `docker ps`):
  // lines with 2+ internal runs of 2+ spaces, i.e. three or more columns.
  // Normal prose has single spaces between words, so it won't match.
  const columnar = lines.filter((l) => {
    const body = l.replace(/^\s+/, ''); // ignore leading indentation
    return (body.match(/ {2,}/g)?.length ?? 0) >= 2;
  }).length;
  if (columnar >= 2) return true;

  // Two-column output (`make help`-style name-description listings): a single
  // wide alignment gap of 3+ spaces. Three, not two: typists put exactly two
  // spaces after a sentence, so requiring a third keeps double-spaced prose
  // reflowable while still catching printf-%-aligned columns.
  const twoColumn = lines.filter((l) => / {3,}/.test(l.replace(/^\s+/, ''))).length;
  return twoColumn >= 2;
}

// A log level only counts in log-line position: at the start of a line, or
// after a prefix that contains no lowercase text (timestamps, brackets, pids,
// module names in caps). Prose that merely *mentions* ERROR or WARN — "you
// will see an ERROR in the console" — must not freeze a block: a wrapped
// explanation of a failure is exactly what CleanCopy exists to clean. The
// other trace signals below are structural for the same reason.
const LOG_LEVEL_LINE = /^[^a-z\n]*\b(?:ERROR|WARN|WARNING|DEBUG|TRACE|FATAL)\b/m;
// An exception in log position: a (possibly package-qualified) exception name
// opening the line and ending it or introducing a message, or Java's classic
// "Exception in thread ..." first line.
const EXCEPTION_LINE =
  /^\s*(?:[\w$]+(?:\.[\w$]+)*\.)?\w*Exception(?::|$)|^\s*Exception in thread\b/m;

function looksLikeTrace(text: string): boolean {
  return (
    /^\s*Traceback/m.test(text) ||
    /^\s*at\s+\S/m.test(text) ||
    /File\s+".*",\s+line\s+\d+/.test(text) ||
    LOG_LEVEL_LINE.test(text) ||
    EXCEPTION_LINE.test(text) ||
    /\b\w*Error:/.test(text) ||
    /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text) ||
    /\b0x[0-9a-fA-F]{4,}\b/.test(text)
  );
}

function looksLikeData(lines: string[]): boolean {
  const first = lines[0]?.trim() ?? '';
  if (/^[{[]/.test(first)) return true; // JSON-ish
  if (/^<[a-zA-Z!?]/.test(first)) return true; // XML / HTML-ish
  // "key: value" on most lines ⇒ YAML-ish. A block-sequence item ("- key: value"
  // — the GitHub Actions / docker-compose shape) is the same signal behind a
  // dash marker. Wrapped prose in a list pulls the ratio down (its continuation
  // lines carry no colon), so genuine label: value structure still separates
  // from a reflowable list.
  const kv = lines.filter(
    (l) => /^\s*[\w.-]+:\s+\S/.test(l) || /^\s*-\s+[\w.-]+:(?:\s|$)/.test(l),
  ).length;
  return lines.length >= 2 && kv >= Math.ceil(lines.length * 0.6);
}

// A unified-diff block. Header lines (`diff --git`, `@@ … @@`, `---`/`+++`)
// are definitive on their own. Bare change markers — a sign glued directly to
// the text, unlike a list dash's trailing space — need two hits before they
// outweigh the small chance of a prose line starting with a signed word.
// Matters because a diff of *prose* has none of the code tells below, and
// joining its lines buries the +/- markers mid-sentence.
function looksLikeDiff(lines: string[]): boolean {
  if (lines.some((l) => /^(?:diff --git\s|@@ |[-+]{3} )/.test(l))) return true;
  return lines.filter((l) => /^[-+]\S/.test(l)).length >= 2;
}

// One token per line — file listings (`ls -1`, `git status` paths), branch
// lists (`git branch`, where the current branch carries a `* ` marker),
// package lists. Prose never puts a single word on every line, so nothing
// here can be a wrap and every break is structure. Markers are stripped
// before counting so `* main` reads as the one token it is — this guard must
// therefore run before the list branch, and it is what protects every
// permutation of branch-list output regardless of where the starred or the
// long name sits.
function looksLikeTokenList(lines: string[]): boolean {
  return (
    lines.length >= 2 &&
    lines.every((l) => {
      const content = l.replace(LIST_ITEM, '').trim();
      return content.length > 0 && !/\s/.test(content);
    })
  );
}

function looksLikeCode(lines: string[], text: string): boolean {
  if (lines.some((l) => /[;{]\s*$/.test(l))) return true; // line ends in ; or {
  if (lines.some((l) => /^\s*[)}\]]+;?\s*$/.test(l))) return true; // closing-bracket line
  if (/=>|::|->|&&|\|\||===|!==/.test(text)) return true; // operators
  if (lines.some((l) => CODE_STATEMENT.test(l))) return true; // keyword used as code
  if (lines.some((l) => /^\s*[$#%>]\s+\S/.test(l))) return true; // shell / REPL prompt
  // Two or more assignment-shaped lines (`total = price * quantity`): the
  // symbol-density check misses them because a lone "=" is one character among
  // long wordish identifiers, but nobody writes consecutive prose lines that
  // each open with `identifier =`.
  if (lines.filter((l) => /^\s*[\w.$\[\]]+\s*=\s*\S/.test(l)).length >= 2) return true;
  const symbols = text.match(CODE_SYMBOLS)?.length ?? 0;
  const nonSpace = text.replace(/\s/g, '').length || 1;
  return symbols / nonSpace > 0.08; // high symbol density
}

function looksLikeProse(text: string): boolean {
  const nonSpace = text.replace(/\s/g, '').length || 1;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const wordish = letters / nonSpace;
  const words = text.trim().split(/\s+/).length;
  return wordish > 0.7 && words >= 3;
}

/**
 * More confident when the block looks hard-wrapped: several lines of similar
 * length where the inner lines don't end on a sentence-ending mark — the
 * fingerprint of a paragraph chopped by the window's width.
 *
 * A single line scores below REFLOW_THRESHOLD on purpose: it has no break to
 * repair, so reflowing could only collapse its internal spacing — and a lone
 * line offers no structure to prove that spacing isn't deliberate alignment
 * (a copied table row, say). Nothing to gain, real damage possible: skip it.
 */
function proseConfidence(lines: string[]): number {
  if (lines.length < 2) return 0.5;
  // reduce, not Math.max(...spread): a block can run to 100k+ lines, and that
  // many spread arguments overflow the call stack.
  const max = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const inner = lines.slice(0, -1);
  const tight = inner.every((l) => l.length >= max - 15);
  const noStops = inner.every((l) => !/[.!?]$/.test(l.trim()));
  return tight && noStops ? 0.9 : 0.7;
}
