// Shared validation: browser, service worker and backend use the same evidence contract.
export const BRIEF_LIMITS = { sources: 20, passages: 60, characters: 60000 };
const types = ['high', 'medium', 'low'];
function fail(message) { throw new Error(message); }
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must contain 1–${max} characters.`);
  return value;
}
function list(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${label} must contain ${min}–${max} items.`);
  return value;
}
function webURL(value) {
  text(value, 4096, 'Source URL');
  try { if (['http:', 'https:'].includes(new URL(value).protocol)) return value; } catch {}
  fail('Sources must use HTTP or HTTPS URLs.');
}
function sourceKey(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['gclid', 'fbclid', 'msclkid', 'dclid'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.href;
}
export function collectBriefSources(session) {
  const sources = new Map();
  for (const event of session.events || []) {
    if (event.type !== 'highlight' || typeof event.selectedText !== 'string' || !event.selectedText.trim()) continue;
    try { webURL(event.url); } catch { continue; }
    const key = sourceKey(event.url);
    if (!sources.has(key)) sources.set(key, { id: `source-${event.id}`, title: (event.title || event.url).slice(0, 1000), url: event.url, passages: [] });
    sources.get(key).passages.push({ id: event.id, text: event.selectedText });
  }
  return [...sources.values()];
}
export function validateBriefInput(value) {
  const question = text(value?.question, 2000, 'Research question').trim();
  const sourceIds = new Set(), passageIds = new Set();
  let characters = 0;
  const sources = list(value.sources, 1, 20, 'Selected sources').map(source => {
    const id = text(source?.id, 160, 'Source ID');
    if (sourceIds.has(id)) fail('Source IDs must be unique.');
    sourceIds.add(id);
    return { id, title: text(source.title, 1000, 'Source title'), url: webURL(source.url),
      passages: list(source.passages, 1, 60, 'Saved passages').map(passage => {
        const id = text(passage?.id, 160, 'Passage ID');
        if (passageIds.has(id)) fail('Passage IDs must be unique.');
        passageIds.add(id);
        const selectedText = text(passage.text, 3000, 'Saved passage'); characters += selectedText.length;
        return { id, text: selectedText };
      }) };
  });
  if (passageIds.size > 60 || characters > 60000) fail('Select fewer sources: a brief supports up to 60 passages and 60,000 characters.');
  return { question, sources };
}
export function validateBriefResult(value, rawInput) {
  const input = validateBriefInput(rawInput);
  const passages = new Set(input.sources.flatMap(source => source.passages.map(p => p.id)));
  function citations(ids, min = 1, allowed = passages) {
    const result = list(ids, min, 12, 'Evidence references');
    if (new Set(result).size !== result.length || result.some(id => typeof id !== 'string' || !allowed.has(id))) fail('The brief contains an unknown or duplicated evidence reference.');
    return [...result];
  }
  function statement(item, allowed = passages) {
    return { text: text(item?.text, 2000, 'Evidence statement'), citations: citations(item.citations, 1, allowed) };
  }
  const compared = new Set();
  const sources = list(value?.sources, input.sources.length, input.sources.length, 'Source comparisons').map(item => {
    const source = input.sources.find(source => source.id === item?.sourceId);
    if (!source || compared.has(source.id)) fail('Every selected source must have exactly one comparison.');
    compared.add(source.id);
    if (!types.includes(item.relevance)) fail('Invalid relevance rating.');
    const allowed = new Set(source.passages.map(p => p.id));
    return { sourceId: source.id, relevance: item.relevance,
      reason: text(item.reason, 2000, 'Relevance reason'), citations: citations(item.citations, 1, allowed),
      signals: list(item.signals, 0, 5, 'Credibility clues').map(signal => statement(signal, allowed)),
      checks: list(item.checks, 1, 8, 'Verification checks').map(check => text(check, 1000, 'Verification check')) };
  });
  return {
    findings: list(value.findings, 1, 8, 'Findings').map(item => statement(item)), sources,
    outline: list(value.outline, 1, 8, 'Outline sections').map(item => ({ heading: text(item?.heading, 200, 'Section heading'), purpose: text(item.purpose, 1500, 'Section purpose'), citations: citations(item.citations, 0) })),
    gaps: list(value.gaps, 1, 10, 'Research gaps').map(gap => text(gap, 1000, 'Research gap'))
  };
}
export function verifyBriefSnapshot(input, session) {
  const current = collectBriefSources(session);
  for (const source of input.sources) {
    const saved = current.find(item => item.id === source.id);
    if (!saved || saved.url !== source.url || saved.title !== source.title || source.passages.some(p => !saved.passages.some(item => item.id === p.id && item.text === p.text))) {
      fail('The selected evidence has changed or was deleted. Refresh the session before generating another brief.');
    }
  }
}
