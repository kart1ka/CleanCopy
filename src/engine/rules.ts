export const RULES = {
  normalizeLineEndings: { default: true, description: 'Convert CRLF and CR line endings to LF' },
  stripAnsi: { default: true, description: 'Remove terminal escape sequences' },
  removeInvisibleCharacters: { default: true, description: 'Remove zero-width spaces, word joiners, and BOMs; keep ZWJ and ZWNJ' },
  normalizeSpaces: { default: true, description: 'Convert unusual Unicode spaces to ordinary spaces' },
  trimTrailingWhitespace: { default: true, description: 'Remove whitespace at line ends' },
  removeSharedMargin: { default: true, description: 'Remove shared indentation while preserving list nesting' },
  reflowProse: { default: true, description: 'Join detected soft wraps in paragraphs' },
  reflowLists: { default: true, description: 'Join detected soft wraps within list items' },
  collapseProseSpaces: { default: true, description: 'Collapse repeated internal spaces in eligible prose and lists' },
  trimOuterBlankLines: { default: true, description: 'Remove outer blank lines, keeping one final line ending if present' },
};

export type RuleId = keyof typeof RULES;
export type Rules = Readonly<Record<RuleId, boolean>>;
export type RuleOverrides = Partial<Record<RuleId, boolean>>;

export function isRuleId(value: string): value is RuleId {
  return Object.prototype.hasOwnProperty.call(RULES, value);
}

export const RULE_IDS = Object.keys(RULES).filter(isRuleId);

export function resolveRules(overrides: RuleOverrides = {}): Rules {
  return {
    normalizeLineEndings: overrides.normalizeLineEndings ?? RULES.normalizeLineEndings.default,
    stripAnsi: overrides.stripAnsi ?? RULES.stripAnsi.default,
    removeInvisibleCharacters: overrides.removeInvisibleCharacters ?? RULES.removeInvisibleCharacters.default,
    normalizeSpaces: overrides.normalizeSpaces ?? RULES.normalizeSpaces.default,
    trimTrailingWhitespace: overrides.trimTrailingWhitespace ?? RULES.trimTrailingWhitespace.default,
    removeSharedMargin: overrides.removeSharedMargin ?? RULES.removeSharedMargin.default,
    reflowProse: overrides.reflowProse ?? RULES.reflowProse.default,
    reflowLists: overrides.reflowLists ?? RULES.reflowLists.default,
    collapseProseSpaces: overrides.collapseProseSpaces ?? RULES.collapseProseSpaces.default,
    trimOuterBlankLines: overrides.trimOuterBlankLines ?? RULES.trimOuterBlankLines.default,
  };
}
