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

/** A line that starts a bullet or numbered list item. */
export const LIST_ITEM = /^\s*([-*+•]\s+|\d+[.)]\s+)/;

const CODE_KEYWORD =
  /^\s*(const|let|var|def|func|function|class|import|export|return|if|else|for|while|switch|public|private|package|using)\b/;
const CODE_SYMBOLS = /[{}\[\]<>;=|\\`]/g;

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

function verbatim(type: Classification['type'], signals: string[]): Classification {
  return { type, reflowable: false, confidence: 0.9, signals };
}

function looksLikeTable(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const piped = lines.filter((l) => (l.match(/\|/g)?.length ?? 0) >= 1).length;
  return piped >= 2;
}

function looksLikeTrace(text: string): boolean {
  return (
    /^\s*Traceback/m.test(text) ||
    /^\s*at\s+\S/m.test(text) ||
    /File\s+".*",\s+line\s+\d+/.test(text) ||
    /\b(ERROR|WARN|WARNING|DEBUG|TRACE|FATAL|Exception)\b/.test(text) ||
    /\b\w*Error:/.test(text) ||
    /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text) ||
    /\b0x[0-9a-fA-F]{4,}\b/.test(text)
  );
}

function looksLikeData(lines: string[]): boolean {
  const first = lines[0]?.trim() ?? '';
  if (/^[{[]/.test(first)) return true; // JSON-ish
  if (/^<[a-zA-Z!?]/.test(first)) return true; // XML / HTML-ish
  // "key: value" on most lines ⇒ YAML-ish.
  const kv = lines.filter((l) => /^\s*[\w.-]+:\s+\S/.test(l)).length;
  return lines.length >= 2 && kv >= Math.ceil(lines.length * 0.6);
}

function looksLikeCode(lines: string[], text: string): boolean {
  if (lines.some((l) => /[;{]\s*$/.test(l))) return true; // line ends in ; or {
  if (lines.some((l) => /^\s*[)}\]]+;?\s*$/.test(l))) return true; // closing-bracket line
  if (/=>|::|->|&&|\|\||===|!==/.test(text)) return true; // operators
  if (lines.some((l) => CODE_KEYWORD.test(l))) return true; // language keywords
  if (lines.some((l) => /^\s*[$#%>]\s+\S/.test(l))) return true; // shell / REPL prompt
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
 */
function proseConfidence(lines: string[]): number {
  if (lines.length < 2) return 0.6;
  const max = Math.max(...lines.map((l) => l.length));
  const inner = lines.slice(0, -1);
  const tight = inner.every((l) => l.length >= max - 15);
  const noStops = inner.every((l) => !/[.!?]$/.test(l.trim()));
  return tight && noStops ? 0.9 : 0.7;
}
