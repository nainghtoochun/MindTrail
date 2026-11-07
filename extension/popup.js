'use strict';

const $ = id => document.getElementById(id);
let busy = false;
let loaded = false;
let currentSessionId = null;
let currentStopAt = null;
let refreshQueue = Promise.resolve();
let deadlineRefreshPending = false;

async function request(action, data = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...data });
  if (!result?.success) throw new Error(result?.error || 'MindTrail could not connect. Please try again.');
  return result;
}

function setBusy(value) {
  busy = value;
  $('app').setAttribute('aria-busy', String(value));
  for (const id of ['start', 'stop', 'session-name', 'dashboard', 'retry', 'duration', 'extend']) $(id).disabled = value;
}

function showError(error) {
  $('error').textContent = error.message || 'Something went wrong. Please try again.';
  $('error').hidden = false;
}

function render(state) {
  const session = state.sessions.find(item => item.id === state.activeSessionId);
  currentSessionId = session?.id || null;
  currentStopAt = session?.stopAt || null;
  const last = state.sessions.at(-1);
  const ended = !session && ['time_limit', 'manual'].includes(last?.endReason);
  $('notice').hidden = !ended;
  const noticeText = ended ? `Session ended: “${last.name}”. ${last.endReason === 'time_limit' ? 'The recording time limit was reached. ' : ''}All your research is saved. Open the dashboard to review it, or start a new session.` : '';
  if ($('notice').textContent !== noticeText) $('notice').textContent = noticeText;
  if (!session) $('timer-reminder').hidden = true;
  $('idle').hidden = Boolean(session);
  $('recording').hidden = !session;
  if (session) {
    $('current-name').textContent = session.name;
    updateCountdown();
    const stopTime = session.stopAt ? new Date(session.stopAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    $('stop-time').textContent = stopTime ? `Recording will stop at ${stopTime}. You can extend it below.` : 'Your recording time limit is being initialized.';
    $('page-count').textContent = session.events.filter(item => item.type === 'page_visit').length;
    $('highlight-count').textContent = session.events.filter(item => item.type === 'highlight').length;
  }
  loaded = true;
  $('retry').hidden = true;
}

function updateCountdown(checkDeadline = false) {
  if (!currentSessionId || !currentStopAt) {
    $('timer-remaining').textContent = '--:--';
    $('timer-remaining').classList.remove('ending-soon');
    $('timer-reminder').hidden = true;
    return;
  }
  const remaining = Math.max(0, Math.ceil((Date.parse(currentStopAt) - Date.now()) / 1000));
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor(remaining % 3600 / 60);
  const seconds = remaining % 60;
  $('timer-remaining').textContent = hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
  $('timer-remaining').classList.toggle('ending-soon', remaining < 300);
  $('timer-reminder').hidden = remaining >= 300;
  const title = remaining ? 'Less than 5 minutes left' : 'Finishing your session…';
  const detail = remaining ? 'Add 1 hour below to keep recording, or let the timer finish and save your session.' : 'Checking that recording has stopped and your research is saved.';
  if ($('reminder-title').textContent !== title) $('reminder-title').textContent = title;
  if ($('reminder-detail').textContent !== detail) $('reminder-detail').textContent = detail;
  if (checkDeadline && remaining === 0 && !busy && !deadlineRefreshPending) {
    deadlineRefreshPending = true;
    void refresh().catch(showError).finally(() => { deadlineRefreshPending = false; });
  }
}
setInterval(() => updateCountdown(true), 1000);

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
    await request('START_SESSION', { name, windowId: window.id, durationMinutes: Number($('duration').value) });
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
$('extend').addEventListener('click', () => {
  void perform(async () => { await request('EXTEND_SESSION', { sessionId: currentSessionId }); await refresh(); });
});
// Keep deadline warnings current while the popup remains open.
setInterval(() => { if (!busy) void refresh().catch(showError); }, 15000);
$('retry').addEventListener('click', () => { void perform(refresh); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mindtrailState) {
    void refresh().catch(showError);
  }
});
void perform(refresh);
