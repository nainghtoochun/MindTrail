import { collectBriefSources, validateBriefInput, validateBriefResult } from './brief-contract.mjs';
import { generateResearchBrief } from './api.js';
const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId');
let session, sources = [], selected = new Set(), controller = null, draft = null, saving = false;
function el(tag, text, className) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text;
  if (className) node.className = className; return node;
}
function link(text, url) {
  const node = el('a', text); node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; return node;
}
function error(message) { $('error').textContent = message; $('error').hidden = false; }
async function message(action, data = {}) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Open Research brief from the installed MindTrail extension.');
  const response = await chrome.runtime.sendMessage({ action, sessionId, ...data });
  if (!response?.success) throw new Error(response?.error || 'MindTrail could not complete this action.');
  return response;
}
function controls() {
  const chosen = sources.filter(source => selected.has(source.id));
  const passages = chosen.flatMap(source => source.passages);
  $('selection-count').textContent = `${chosen.length} sources · ${passages.length} passages · ${passages.reduce((n, p) => n + p.text.length, 0).toLocaleString()} characters selected`;
  $('generate').disabled = Boolean(controller) || !chosen.length;
  $('refresh').disabled = Boolean(controller);
  $('question').disabled = Boolean(controller);
  $('cancel').hidden = !controller || saving;
  const retry = document.getElementById('retry-save');
  if (retry) retry.disabled = Boolean(controller) || saving;
  $('generate').textContent = controller ? 'Generating research brief…' : session?.researchBrief ? 'Regenerate research brief' : 'Generate research brief';
  document.querySelectorAll('#source-list input').forEach(input => { input.disabled = Boolean(controller) || (!input.checked && selected.size >= 20); });
}
function renderSources() {
  $('source-list').replaceChildren();
  sources.forEach((source, index) => {
    const row = el('article', undefined, 'source'); const heading = el('div', undefined, 'source-heading');
    const input = el('input'); input.type = 'checkbox'; input.id = `choose-${index}`; input.checked = selected.has(source.id);
    input.addEventListener('change', () => { if (input.checked && selected.size < 20) selected.add(source.id); else selected.delete(source.id); controls(); });
    const label = el('label', source.title); label.htmlFor = input.id; heading.append(input, label); row.append(heading);
    const details = el('details'); details.append(el('summary', `Review ${source.passages.length} saved passage(s) to be sent`), link(source.url, source.url));
    source.passages.forEach(passage => details.append(el('blockquote', passage.text)));
    row.append(details); $('source-list').append(row);
  });
  controls();
}
async function load() {
  if (controller) return;
  $('error').hidden = true;
  try {
    const { state } = await message('GET_STATE');
    const found = state.sessions.find(item => item.id === sessionId);
    if (!found) throw new Error('This session no longer exists. Return to your research sessions.');
    const firstLoad = !session;
    session = found; sources = collectBriefSources(session);
    selected = firstLoad ? new Set(sources.slice(0, 10).map(source => source.id)) : new Set([...selected].filter(id => sources.some(source => source.id === id)));
    $('session-name').textContent = session.name;
    $('coverage').textContent = `${sources.length} source(s) have saved highlights. Select the sources relevant to this assignment.`;
    $('brief-form').hidden = false;
    if (firstLoad && session.researchBrief) {
      $('question').value = session.researchBrief.input.question;
      selected = new Set(session.researchBrief.input.sources.map(source => source.id).filter(id => sources.some(source => source.id === id)));
      renderReport(session.researchBrief);
    }
    renderSources();
    $('status').textContent = sources.length ? 'Your saved evidence is ready. Review the passages before generating.' : 'Save a highlight during a research session to create a brief. Browsing history alone is not enough evidence.';
  } catch (err) { error(err.message); $('status').textContent = 'Research could not be loaded.'; }
}
function renderReport(brief, unsaved = false) {
  const input = validateBriefInput(brief.input), result = validateBriefResult(brief.result, input);
  const box = $('report'); box.replaceChildren(); box.hidden = false;
  const evidence = new Map();
  input.sources.forEach(source => source.passages.forEach(passage => evidence.set(passage.id, { source, passage, number: evidence.size + 1 })));
  function cite(ids) {
    const span = el('span', undefined, 'citations');
    ids.forEach(id => { const item = evidence.get(id); const a = el('a', `[${item.number}]`); a.href = `#evidence-${item.number}`; a.title = item.source.title; span.append(a); });
    return span;
  }
  box.append(el('h2', 'Your research brief'), el('p', input.question));
  box.append(el('p', unsaved ? 'Generated but not saved yet. Keep this page open and retry saving.' : `Saved ${new Date(brief.generatedAt).toLocaleString()}. Based on ${input.sources.length} sources and ${evidence.size} passages at generation time. New highlights require regeneration.`, 'notice'));
  if (unsaved) {
    const retry = el('button', 'Retry saving brief'); retry.type = 'button'; retry.id = 'retry-save'; retry.disabled = Boolean(controller); retry.addEventListener('click', async () => {
      if (controller || saving) return;
      controller = new AbortController(); controls();
      try { await saveDraft(); $('status').textContent = 'Research brief saved.'; } catch (err) { error(err.message); }
      finally { controller = null; controls(); }
    }); box.append(retry);
  }
  box.append(el('h3', 'Findings from your saved passages'));
  const findings = el('ul'); result.findings.forEach(item => { const li = el('li', item.text); li.append(cite(item.citations)); findings.append(li); }); box.append(findings);
  box.append(el('h3', 'Source comparison'), el('p', 'Relevance is judged against your question. All sources remain unverified; clues below are claims visible in excerpts, not independent credibility checks.', 'helper'));
  const wrapper = el('div', undefined, 'table-wrap'), table = el('table'), head = el('thead'), tr = el('tr');
  ['Source', 'Relevance and contribution', 'Credibility clues in excerpts', 'Checks still needed'].forEach(text => tr.append(el('th', text))); head.append(tr); table.append(head);
  const body = el('tbody'); const rank = { high: 0, medium: 1, low: 2 };
  [...result.sources].sort((a, b) => rank[a.relevance] - rank[b.relevance]).forEach(item => {
    const source = input.sources.find(source => source.id === item.sourceId); const row = el('tr');
    const name = el('td'); name.append(link(source.title, source.url), el('p', 'Not independently verified', 'helper'));
    const relevance = el('td'); relevance.append(el('strong', `${item.relevance.toUpperCase()} relevance`), el('p', item.reason), cite(item.citations));
    const signals = el('td'); if (!item.signals.length) signals.append(el('p', 'No credibility clues identified in the selected passages.'));
    item.signals.forEach(signal => { const p = el('p', signal.text); p.append(cite(signal.citations)); signals.append(p); });
    const checks = el('td'), list = el('ul'); item.checks.forEach(check => list.append(el('li', check))); checks.append(list);
    row.append(name, relevance, signals, checks); body.append(row);
  }); table.append(body); wrapper.append(table); box.append(wrapper);
  box.append(el('h3', 'Suggested report outline'));
  const outline = el('ol'); result.outline.forEach(section => { const li = el('li'); li.append(el('strong', section.heading), el('p', section.purpose), section.citations.length ? cite(section.citations) : el('p', 'Evidence gap — further research needed.', 'helper')); outline.append(li); }); box.append(outline);
  box.append(el('h3', 'What to investigate next')); const gaps = el('ul'); result.gaps.forEach(gap => gaps.append(el('li', gap))); box.append(gaps);
  box.append(el('h3', 'Evidence references'), el('p', 'These references point to your exact saved selections. They are not verified bibliographic citations. Open the original source to check context and publication details.', 'helper'));
  evidence.forEach(({ source, passage, number }) => {
    const card = el('article', undefined, 'card evidence'); card.id = `evidence-${number}`;
    card.append(el('h3', `[${number}] ${source.title}`), link(source.url, source.url), el('blockquote', passage.text)); box.append(card);
  });
}
async function saveDraft() {
  saving = true; controls();
  try {
    const { brief } = await message('SAVE_RESEARCH_BRIEF', draft);
    session.researchBrief = brief; draft = null; renderReport(brief);
  } finally { saving = false; controls(); }
}
$('brief-form').addEventListener('submit', async event => {
  event.preventDefault(); if (controller) return;
  $('error').hidden = true;
  let input;
  try { input = validateBriefInput({ question: $('question').value, sources: sources.filter(source => selected.has(source.id)) }); }
  catch (err) { error(err.message); return; }
  controller = new AbortController(); controls(); $('status').textContent = 'Comparing the selected passages with your question…';
  try {
    const result = validateBriefResult(await generateResearchBrief(input, controller.signal), input);
    if (controller.signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    draft = { input, result }; renderReport(draft, true);
    await saveDraft(); $('status').textContent = 'Research brief saved with this session. Review its evidence before using it in your report.';
  } catch (err) {
    if (err.name === 'AbortError') $('status').textContent = 'Generation cancelled. Your previous saved brief is unchanged.';
    else { error(err.message); $('status').textContent = draft ? 'Your generated brief is still on this page. Retry saving it.' : 'Generation failed. Your saved research is unchanged.'; }
  } finally { controller = null; controls(); }
});
$('cancel').addEventListener('click', () => controller?.abort());
$('refresh').addEventListener('click', () => { void load(); });
void load();
