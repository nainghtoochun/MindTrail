'use strict';
const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId');
let session = null, active = false, busy = false, refreshing = false;
function text(id, value) { if ($(id).textContent !== value) $(id).textContent = value; }
async function request(action, extra = {}) {
  const result = await chrome.runtime.sendMessage({ action, sessionId, ...extra });
  if (!result?.success) throw new Error(result?.error || 'Could not update this session. Please retry.');
  return result;
}
function render() {
  text('session-name', session?.name || '');
  const remaining = active && session?.stopAt ? Math.max(0, Math.ceil((Date.parse(session.stopAt) - Date.now()) / 1000)) : 0;
  const warning = active && remaining > 0 && remaining < 300;
  document.body.classList.toggle('ended', !active);
  $('extend').hidden = !warning;
  $('countdown-panel').hidden = !active;
  if (!session) {
    text('title', 'Session unavailable'); text('message', 'This session may have been deleted. Open your dashboard to view your saved research.');
  } else if (!active && session.endedAt) {
    text('title', 'Your research session has ended'); text('message', 'Recording has stopped. Your pages, highlights and explanations are saved. Open the dashboard to revisit your research.');
  } else if (warning) {
    text('title', 'Less than 5 minutes left'); text('message', 'Your research session will end soon. Add an hour to keep recording, or let the timer finish and save your research.');
  } else if (active && remaining === 0) {
    text('title', 'Finishing your session…'); text('message', 'Checking that recording has stopped and your research is saved.');
  } else {
    text('title', 'Recording continues'); text('message', 'You have more time to explore. This reminder can be dismissed while MindTrail keeps recording.');
  }
  const hours = Math.floor(remaining / 3600), minutes = Math.floor(remaining % 3600 / 60), seconds = remaining % 60;
  text('countdown', hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`);
  $('extend').disabled = busy;
  $('dashboard').disabled = busy;
}
async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    const { state } = await request('GET_STATE');
    session = state.sessions.find(item => item.id === sessionId) || null;
    active = Boolean(session && state.activeSessionId === session.id);
    render();
  } catch (error) {
    text('error', error.message); $('error').hidden = false;
  } finally { refreshing = false; }
}
$('extend').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('error').hidden = true; render();
  try { await request('EXTEND_SESSION'); }
  catch (error) { text('error', error.message); $('error').hidden = false; }
  finally { busy = false; await refresh(); }
});
$('dashboard').addEventListener('click', async () => {
  if (busy) return;
  busy = true; render();
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); }
  catch (error) { text('error', error.message); $('error').hidden = false; }
  finally { busy = false; render(); }
});
$('dismiss').addEventListener('click', async () => {
  try { const current = await chrome.windows.getCurrent(); await chrome.windows.remove(current.id); }
  catch (error) { text('error', error.message); $('error').hidden = false; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.mindtrailState) void refresh();
});
setInterval(() => { if (session) render(); if (active && Date.parse(session.stopAt) <= Date.now()) void refresh(); }, 1000);
setInterval(() => { void refresh(); }, 15000);
void refresh();
