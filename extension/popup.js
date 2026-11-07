'use strict';

const $ = id => document.getElementById(id);
let busy = false;
let loaded = false;
let refreshQueue = Promise.resolve();

async function request(action, data = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...data });
  if (!result?.success) throw new Error(result?.error || 'MindTrail could not connect. Please try again.');
  return result;
}

function setBusy(value) {
  busy = value;
  $('app').setAttribute('aria-busy', String(value));
  for (const id of ['start', 'stop', 'session-name', 'dashboard', 'retry']) $(id).disabled = value;
}

function showError(error) {
  $('error').textContent = error.message || 'Something went wrong. Please try again.';
  $('error').hidden = false;
}

function render(state) {
  const session = state.sessions.find(item => item.id === state.activeSessionId);
  $('idle').hidden = Boolean(session);
  $('recording').hidden = !session;
  if (session) {
    $('current-name').textContent = session.name;
    $('page-count').textContent = session.events.filter(item => item.type === 'page_visit').length;
    $('highlight-count').textContent = session.events.filter(item => item.type === 'highlight').length;
  }
  loaded = true;
  $('retry').hidden = true;
}

function refresh() {
  // Storage notifications and button responses can arrive together; render them
  // in request order so an older response cannot replace a newer state.
  refreshQueue = refreshQueue.catch(() => {}).then(async () => {
    const { state } = await request('GET_STATE');
    render(state);
  });
  return refreshQueue;
}

async function perform(operation) {
  if (busy) return;
  setBusy(true);
  $('error').hidden = true;
  try { await operation(); }
  catch (error) {
    showError(error);
    $('retry').hidden = loaded;
  } finally {
    $('loading').hidden = true;
    setBusy(false);
  }
}

$('start-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const name = $('session-name').value.trim();
    if (!name) throw new Error('Give your research session a name.');
    const window = await chrome.windows.getCurrent();
    await request('START_SESSION', { name, windowId: window.id });
    await refresh();
  });
});
$('stop').addEventListener('click', () => {
  void perform(async () => { await request('STOP_SESSION'); await refresh(); });
});
$('dashboard').addEventListener('click', () => {
  void perform(async () => {
    const url = chrome.runtime.getURL('dashboard.html');
    // The dashboard is supplied separately. Explain a missing integration file
    // instead of sending the user to a broken Chrome extension page.
    let response;
    try { response = await fetch(url); } catch {
      throw new Error('The dashboard is not installed yet. Your research is saved.');
    }
    if (!response.ok) throw new Error('The dashboard is not installed yet. Your research is saved.');
    await chrome.tabs.create({ url });
  });
});
$('retry').addEventListener('click', () => { void perform(refresh); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mindtrailState) {
    void refresh().catch(showError);
  }
});
void perform(refresh);
