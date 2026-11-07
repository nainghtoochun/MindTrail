import { explainHighlight, isExplanation } from './api.js';

const $ = id => document.getElementById(id);
const extensionMode = location.protocol === 'chrome-extension:';
let preview = !extensionMode;
let state = { activeSessionId: null, sessions: [] };
let selectedId = null;
let query = '';
let toastTimer;
const pending = new Set();
const errors = new Map();
const drafts = new Map();
const busyActions = new Set();
const previewKey = 'mindtrail-dashboard-preview-v1';

function mockState() {
  const event = (id, type, minute, title, url, selectedText = null, explanation = null) => ({ id, type, timestamp: `2026-11-07T17:${minute}:00Z`, tabId: 10, title, url, selectedText, explanation, status: type === 'highlight' ? (explanation ? 'complete' : 'pending') : null });
  return { activeSessionId: 'session-ml', sessions: [
    { id: 'session-ml', name: 'Learning Machine Learning', windowId: 1, startedAt: '2026-11-07T17:00:00Z', endedAt: null, events: [
      event('ml-start', 'session_started', '00', 'Research session started', ''),
      event('ml-page-1', 'page_visit', '01', 'Neural networks and deep learning', 'https://www.3blue1brown.com/topics/neural-networks'),
      event('ml-highlight-1', 'highlight', '04', 'Neural networks and deep learning', 'https://www.3blue1brown.com/topics/neural-networks', 'Backpropagation computes the gradient of the loss function with respect to each weight by applying the chain rule.', { term: 'Backpropagation', simpleExplanation: 'Backpropagation figures out how much each connection in a neural network contributed to a prediction error. It works backward from the result, calculating gradients that an optimizer can use to adjust the weights.', example: 'Imagine a team baking a cake. If it turns out too sweet, you trace the result back through the recipe to work out which ingredients contributed most.', keyTakeaway: 'Backpropagation calculates the gradients; the optimizer uses them to improve the network.' }),
      event('ml-page-2', 'page_visit', '09', 'An overview of gradient descent optimization algorithms', 'https://www.ruder.io/optimizing-gradient-descent/'),
      event('ml-highlight-2', 'highlight', '12', 'An overview of gradient descent optimization algorithms', 'https://www.ruder.io/optimizing-gradient-descent/', 'The learning rate determines the size of the steps we take to reach a minimum.'),
      event('ml-switch', 'tab_switch', '16', 'Neural networks and deep learning', 'https://www.3blue1brown.com/topics/neural-networks')
    ] },
    { id: 'session-design', name: 'Designing for curious minds', windowId: 1, startedAt: '2026-11-06T19:00:00Z', endedAt: '2026-11-06T19:32:00Z', events: [
      { ...event('design-page', 'page_visit', '01', 'Recognition vs. recall in user interfaces', 'https://www.nngroup.com/articles/recognition-and-recall/'), timestamp: '2026-11-06T19:01:00Z' }
    ] },
    { id: 'session-climate', name: 'A better understanding of climate', windowId: 1, startedAt: '2026-11-05T20:00:00Z', endedAt: '2026-11-05T20:18:00Z', events: [] }
  ] };
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, handler) {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node;
}
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
function safeUrl(url) { try { const value = new URL(url); return ['http:', 'https:'].includes(value.protocol) ? value : null; } catch { return null; } }
function hostname(url) { return safeUrl(url)?.hostname.replace(/^www\./, '') || 'Source unavailable'; }
function date(value, options) { const d = new Date(value); return Number.isNaN(d.getTime()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, options).format(d); }
function duration(session) {
  const start = new Date(session.startedAt).getTime();
  const end = new Date(session.endedAt || (preview ? '2026-11-07T17:24:00Z' : Date.now())).getTime();
  const minutes = Math.max(0, Math.round((end - start) / 60000));
  return Number.isFinite(minutes) ? (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`) : '—';
}
function uniqueUrls(session) { return [...new Set(session.events.map(e => safeUrl(e.url)?.href).filter(Boolean))]; }
function persistPreview() { try { localStorage.setItem(previewKey, JSON.stringify(state)); } catch { toast('Preview changes could not be stored on this browser.'); } }
async function message(payload) {
  if (!preview) {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.success) throw new Error(response?.error || response?.message || 'The extension could not complete this action.');
    return response;
  }
  if (payload.action === 'GET_STATE') return { success: true, state };
  const session = state.sessions.find(s => s.id === payload.sessionId);
  if (!session) throw new Error('This session no longer exists.');
  if (payload.action === 'UPDATE_EXPLANATION') {
    const event = session.events.find(e => e.id === payload.eventId);
    if (!event) throw new Error('This highlight no longer exists.');
    event.explanation = payload.explanation; event.status = 'complete';
  }
  if (payload.action === 'DELETE_SESSION') {
    state.sessions = state.sessions.filter(s => s.id !== session.id);
    if (state.activeSessionId === session.id) state.activeSessionId = null;
  }
  if (payload.action === 'RESTORE_SESSION') throw new Error('Tab restoration requires the Chrome extension background worker.');
  persistPreview();
  return { success: true };
}
function previewBanner() {
  $('mode-banner').hidden = !preview;
  $('mode-banner').textContent = 'Preview workspace · Sample research, saved locally in this browser. AI explanations use your local backend. Tab restoration requires the extension.';
}
async function loadState() {
  try {
    const response = await message({ action: 'GET_STATE' });
    if (!response.state || !Array.isArray(response.state.sessions)) throw new Error('The background returned an invalid research state.');
    state = response.state;
    if (!state.sessions.some(s => s.id === selectedId)) selectedId = state.sessions.find(s => s.id === state.activeSessionId)?.id || state.sessions[0]?.id || null;
    render();
  } catch (error) {
    $('content').replaceChildren(el('div', 'empty'));
    const box = $('content').firstChild;
    box.append(el('h2', '', 'Your research is not connected yet'), el('p', '', error.message), button('Retry connection', 'button', loadState));
    if (extensionMode) box.append(button('Open sample preview', 'button secondary', () => { startPreview(); loadState(); }));
  } finally { $('content').setAttribute('aria-busy', 'false'); }
}
function startPreview() {
  preview = true;
  try { const saved = JSON.parse(localStorage.getItem(previewKey)); state = saved && Array.isArray(saved.sessions) ? saved : mockState(); } catch { state = mockState(); }
  previewBanner();
}
function renderSidebar() {
  $('session-count').textContent = state.sessions.length;
  const list = $('sessions'); list.replaceChildren();
  const matches = state.sessions.filter(s => `${s.name} ${s.events.map(e => `${e.selectedText || ''} ${e.explanation ? Object.values(e.explanation).join(' ') : ''}`).join(' ')}`.toLowerCase().includes(query));
  for (const session of [...matches].sort((a,b) => new Date(b.startedAt) - new Date(a.startedAt))) {
    const item = button('', 'session' + (session.id === selectedId ? ' selected' : ''), () => { selectedId = session.id; render(); });
    item.setAttribute('aria-current', session.id === selectedId ? 'true' : 'false');
    const title = el('span', 'session-name');
    title.append(el('span', session.id === state.activeSessionId ? 'dot' : '', session.id === state.activeSessionId ? '' : '◷'), document.createTextNode(session.name));
    item.append(title, el('div', 'session-meta', `${date(session.startedAt, { month: 'short', day: 'numeric' })} · ${session.events.filter(e => e.type === 'page_visit').length} pages`));
    list.append(item);
  }
  if (!matches.length) list.append(el('p', 'helper', query ? 'No matching research sessions.' : 'Your first trail starts in the extension.'));
}
function render() {
  renderSidebar();
  const content = $('content'); content.replaceChildren();
  const session = state.sessions.find(s => s.id === selectedId);
  if (!session) {
    const empty = el('div', 'empty'); empty.append(el('h2', '', 'Make room for your next discovery'), el('p', '', 'Open MindTrail in your toolbar and start a named research session. Your pages and saved highlights will appear here.')); content.append(empty); return;
  }
  content.append(el('div', 'eyebrow', 'FOLLOW YOUR CURIOSITY'));
  const titleRow = el('div', 'title-row'); titleRow.append(el('h1', '', session.name));
  const actions = el('div', 'actions');
  const restore = button('↗ Restore tabs', 'button', () => restoreSession(session));
  const remove = button('Delete', 'button secondary danger', () => deleteSession(session));
  restore.disabled = busyActions.has(session.id) || !uniqueUrls(session).length; remove.disabled = busyActions.has(session.id);
  actions.append(restore, remove); titleRow.append(actions); content.append(titleRow);
  const subtitle = el('div', 'subtitle');
  subtitle.append(el('span', '', date(session.startedAt, { month: 'long', day: 'numeric', year: 'numeric' })), el('span', '', `◷ ${duration(session)} of exploration`));
  if (state.activeSessionId === session.id) { const active = el('span', 'recording'); active.append(el('span', 'dot'), document.createTextNode('Recording')); subtitle.append(active); }
  content.append(subtitle);
  const stats = el('div', 'stats');
  for (const [icon, value, label] of [['▧', session.events.filter(e => e.type === 'page_visit').length, 'Pages visited'], ['✧', session.events.filter(e => e.type === 'highlight').length, 'Highlights saved'], ['◷', duration(session), 'Time exploring']]) {
    const stat = el('div', 'stat'); const detail = el('div'); detail.append(el('strong', '', value), el('small', '', label)); stat.append(el('span', 'stat-icon', icon), detail); stats.append(stat);
  }
  content.append(stats);
  const heading = el('div', 'replay-heading'); const introduction = el('div'); introduction.append(el('h2', '', 'Research replay'), el('p', '', 'Every stop, every spark. Pick up right where you left off.')); heading.append(introduction, el('span', 'chronological', '↓ Chronological')); content.append(heading);
  const timeline = el('div', 'timeline'); let day = '';
  for (const event of [...session.events].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp))) {
    const currentDay = date(event.timestamp, { month: 'long', day: 'numeric', year: 'numeric' });
    if (currentDay !== day) { timeline.append(el('div', 'date-label', currentDay.toUpperCase())); day = currentDay; }
    timeline.append(renderEvent(session, event));
  }
  if (!session.events.length) timeline.append(el('div', 'empty', 'Your trail is ready. Visit a page or save a highlight to begin.'));
  content.append(timeline);
}
function renderEvent(session, event) {
  const labels = { session_started: 'SESSION STARTED', page_visit: 'PAGE VISITED', tab_switch: 'TAB SWITCHED', highlight: 'HIGHLIGHT SAVED', session_ended: 'SESSION ENDED' };
  const article = el('article', 'event' + (event.type === 'highlight' ? ' highlight' : ''));
  article.append(el('span', 'event-marker', event.type === 'highlight' ? '✧' : '•'));
  const card = el('div', 'event-card'); const meta = el('div', 'event-meta'); const time = el('time', '', date(event.timestamp, { hour: 'numeric', minute: '2-digit' })); time.dateTime = event.timestamp;
  meta.append(el('span', 'event-label', labels[event.type] || 'RESEARCH EVENT'), time); card.append(meta);
  const source = el('div', 'source-row'); const detail = el('div', 'source-detail');
  detail.append(el('div', 'source-title', event.title || labels[event.type] || 'Untitled source'));
  if (event.url) detail.append(el('div', 'source-url', `${hostname(event.url)} · ${event.url}`));
  source.append(el('span', 'site-icon', event.type === 'highlight' ? '❝' : '▧'), detail);
  const url = safeUrl(event.url);
  if (url) { const link = el('a', 'source-link', 'Open source ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; source.append(link); }
  card.append(source);
  if (event.type === 'highlight') {
    card.append(el('blockquote', 'quote', event.selectedText || 'No selected text was recorded.'));
    const key = `${session.id}:${event.id}`;
    const explanation = event.explanation || drafts.get(key);
    if (isExplanation(explanation)) card.append(explanationCard(explanation, Boolean(drafts.has(key) && !event.explanation)));
    if (!event.explanation) {
      const actions = el('div', 'explain-actions');
      const explain = button(pending.has(key) ? '✧ Explaining…' : drafts.has(key) ? 'Retry saving explanation' : '✦ Explain with Gemini', 'button secondary', () => generateExplanation(session.id, event.id));
      explain.disabled = pending.has(key) || !event.selectedText;
      actions.append(explain, el('span', 'helper', pending.has(key) ? 'Making the complex a little clearer.' : 'A little clarity, powered by Gemini.')); card.append(actions);
      const error = errors.get(key) || (event.status === 'error' ? 'The previous explanation failed. You can retry.' : '');
      if (error) { const feedback = el('div', 'error', error); feedback.setAttribute('role', 'alert'); card.append(feedback); }
    }
  }
  article.append(card); return article;
}
function explanationCard(explanation, unsaved) {
  const box = el('section', 'explanation'); const heading = el('div', 'ai-heading');
  heading.append(el('span', '', unsaved ? '✦ GEMINI EXPLANATION · NOT SAVED YET' : '✦ A LITTLE CLARITY · GEMINI'));
  heading.append(button('▢ Copy', 'copy', async () => {
    try { await navigator.clipboard.writeText(`${explanation.term}\n\n${explanation.simpleExplanation}\n\nExample: ${explanation.example}\n\nKey takeaway: ${explanation.keyTakeaway}`); toast('Explanation copied.'); } catch { toast('Clipboard access failed. Please allow clipboard access and retry.'); }
  }));
  box.append(heading, el('h3', '', explanation.term), el('p', '', explanation.simpleExplanation));
  for (const [label, text, className] of [['IN EVERYDAY TERMS', explanation.example, 'example'], ['THE TAKEAWAY', explanation.keyTakeaway, 'takeaway']]) { const p = el('p', className); p.append(el('span', 'mini-label', label), document.createTextNode(text)); box.append(p); }
  return box;
}
async function generateExplanation(sessionId, eventId) {
  const key = `${sessionId}:${eventId}`; if (pending.has(key)) return;
  const event = state.sessions.find(s => s.id === sessionId)?.events.find(e => e.id === eventId); if (!event) return;
  pending.add(key); errors.delete(key); render();
  try {
    const explanation = drafts.get(key) || await explainHighlight({ selectedText: event.selectedText, pageTitle: event.title, pageUrl: event.url });
    drafts.set(key, explanation);
    await message({ action: 'UPDATE_EXPLANATION', sessionId, eventId, explanation });
    drafts.delete(key); await loadState(); toast('Explanation saved to your research.');
  } catch (error) { errors.set(key, error.message + (drafts.has(key) ? ' Your explanation is retained here; retry to save it.' : ' Your highlight is still saved.')); }
  finally { pending.delete(key); render(); }
}
function confirmAction(title, messageText, actionText) {
  const dialog = $('confirm-dialog');
  $('dialog-title').textContent = title; $('dialog-message').textContent = messageText; $('dialog-confirm').textContent = actionText;
  dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function restoreSession(session) {
  const count = uniqueUrls(session).length;
  if (count >= 10 && !await confirmAction('Reopen your research?', `This session contains ${count} unique source URLs. Opening them all may use significant memory.`, `Restore ${count} tabs`)) return;
  busyActions.add(session.id); render();
  try { const response = await message({ action: 'RESTORE_SESSION', sessionId: session.id }); toast(response.message || 'Research tabs restored successfully.'); }
  catch (error) { toast(error.message); }
  finally { busyActions.delete(session.id); render(); }
}
async function deleteSession(session) {
  if (!await confirmAction('Delete this research session?', `“${session.name}” and its saved highlights will be removed. This cannot be undone.`, 'Delete session')) return;
  busyActions.add(session.id); render();
  try { await message({ action: 'DELETE_SESSION', sessionId: session.id }); await loadState(); toast('Research session deleted.'); }
  catch (error) { toast(error.message); }
  finally { busyActions.delete(session.id); render(); }
}
$('search').addEventListener('input', event => { query = event.target.value.toLowerCase().trim(); renderSidebar(); });
$('help').addEventListener('click', () => { toast('Start a session in the extension, browse, then select text and right-click to save it. Return here to replay your research.'); });
if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => { if (!preview && area === 'local' && changes.mindtrailState) loadState(); });
if (preview) startPreview();
previewBanner();
loadState();
