const ELIGIBLE_TYPES = new Set(['message', 'action']);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegexSource(pattern) {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += escapeRegex(ch);
  }
  return out;
}

function buildTest(rule) {
  const flags = rule.case_sensitive ? '' : 'i';
  let source;
  if (rule.kind === 'regex') {
    source = rule.pattern;
  } else if (rule.kind === 'glob') {
    source = `(?:^|\\W)(?:${globToRegexSource(rule.pattern)})(?=\\W|$)`;
  } else {
    source = `(?:^|\\W)(?:${escapeRegex(rule.pattern)})(?=\\W|$)`;
  }
  try {
    const re = new RegExp(source, flags);
    return (text) => re.test(text);
  } catch {
    return null;
  }
}

export function compileRules(rules) {
  const compiled = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!rule.pattern) continue;
    const test = buildTest(rule);
    if (!test) continue;
    compiled.push({ id: rule.id, test });
  }
  return compiled;
}

export function matchEvent(event, compiled) {
  if (!event || !ELIGIBLE_TYPES.has(event.type)) return { matched: false, ruleId: null };
  if (event.self) return { matched: false, ruleId: null };
  const text = event.text || '';
  if (!text) return { matched: false, ruleId: null };
  for (const { id, test } of compiled) {
    if (test(text)) return { matched: true, ruleId: id };
  }
  return { matched: false, ruleId: null };
}
