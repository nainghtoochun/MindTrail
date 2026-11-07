import { validateBriefInput, validateBriefResult, verifyBriefSnapshot } from './brief-contract.mjs';

'use strict';

const STATE_KEY = 'mindtrailState';
const MENU_ID = 'mindtrail-save';
const ACTIONS = new Set([
  'START_SESSION', 'STOP_SESSION', 'GET_STATE', 'UPDATE_EXPLANATION',
  'SAVE_RESEARCH_BRIEF', 'RESTORE_SESSION', 'DELETE_SESSION', 'GET_RESTORE_SOURCES', 'RESTORE_BATCH', 'EXTEND_SESSION'
]);

// Every read/modify/write and recording callback joins this queue. State itself
// always comes from storage, so suspending/restarting the worker loses no data.
let queue = Promise.resolve();
function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

async function readState() {
  const stored = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  if (stored === undefined) return { activeSessionId: null, sessions: [] };
  if (!stored || !Array.isArray(stored.sessions)) {
    throw new Error('MindTrail storage is invalid. Existing data has been preserved.');
  }
  await enforceDeadline(stored);
  return stored;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

function webURL(value) {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function event(type, tab = {}, extra = {}) {
  return {
    id: crypto.randomUUID(), type, timestamp: new Date().toISOString(),
    tabId: tab.id ?? null, title: tab.title || tab.url || null,
    url: tab.url || null, selectedText: null, explanation: null,
    status: null, ...extra
  };
}

function activeSession(state) {
  return state.sessions.find(session => session.id === state.activeSessionId);
}

function findSession(state, id) {
  const session = state.sessions.find(item => item.id === id);
  if (!session) throw new Error('Session not found. It may have been deleted.');
  return session;
}

// These markers live in the event log rather than worker memory. A -> B -> A
// remains three visits, while repeated updates for A collapse to one visit.
function lastVisit(session, tabId) {
  return session.events.findLast(item => item.type === 'page_visit' && item.tabId === tabId);
}

// Keep recording/automatic-stop status visible even after saving a highlight.
async function feedback(message, failed = false) {
  const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
  const recording = Boolean(state?.activeSessionId);
  const timedOut = !recording && state?.sessions.at(-1)?.endReason === 'time_limit';
  await Promise.all([
    chrome.action.setBadgeText({ text: recording ? 'REC' : timedOut ? 'STOP' : failed ? '!' : '' }),
    chrome.action.setBadgeBackgroundColor({ color: failed || timedOut ? '#a44232' : '#b5523c' }),
    chrome.action.setTitle({ title: `MindTrail — ${recording ? 'Recording · ' : ''}${message}` })
  ]);
}

const TIMER = 'mindtrail-session-deadline';
const MINUTE = 60000;
function duration(value = 120) {
  if (!Number.isInteger(value) || value < 6 || value > 480) {
    throw new Error('Choose a recording limit between 6 and 480 minutes.');
  }
  return value;
}
async function notifySession(session, kind, message) {
  try {
    await chrome.notifications.create(`mindtrail-${kind}-${session.id}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('notification-icon.png'),
      title: `MindTrail · ${session.name}`, message, requireInteraction: true
    });
  } catch (error) {
    // OS notifications can be blocked. The persistent popup notice and badge
    // remain available; notification failure must never prevent saving a stop.
    console.warn('MindTrail notification unavailable:', error.message);
  }
}
function finishSession(state, session, reason, timestamp = new Date().toISOString()) {
  session.events.push(event('session_ended', {}, { timestamp,
    title: reason === 'time_limit' ? 'Recording stopped at the time limit — research saved' : 'Research saved' }));
  session.endedAt = timestamp;
  session.endReason = reason;
  state.activeSessionId = null;
}
async function enforceDeadline(state) {
  const session = activeSession(state);
  if (!session) return;
  if (!session.stopAt) {
    // Existing recordings get a fresh, announced limit instead of expiring on upgrade.
    session.durationMinutes = 120;
    session.stopAt = new Date(Date.now() + 120 * MINUTE).toISOString();
    await saveState(state);
    await notifySession(session, 'limit', 'Recording now has a 2-hour limit. Open MindTrail to see or extend the stop time.');
  }
  const remaining = Date.parse(session.stopAt) - Date.now();
  if (remaining <= 0) {
    finishSession(state, session, 'time_limit', session.stopAt);
    await saveState(state);
    await chrome.alarms.clear(TIMER);
    await feedback('Time limit reached. Recording stopped; all research is saved.').catch(() => {});
    await notifySession(session, 'stopped', 'Your time limit was reached. Recording stopped and your research is saved. Open MindTrail to start a new session.');
  } else if (remaining <= 5 * MINUTE && !session.limitWarningAt) {
    session.limitWarningAt = new Date().toISOString();
    await saveState(state);
    await notifySession(session, 'warning', 'Recording stops in 5 minutes or less. Open MindTrail and choose “Add 1 hour” to keep recording.');
  }
}
async function ensureTimer(state) {
  if (activeSession(state)) {
    if (!await chrome.alarms.get(TIMER)) await chrome.alarms.create(TIMER, { periodInMinutes: 1 });
  } else await chrome.alarms.clear(TIMER);
}

// Remove only well-known tracking parameters. Keep fragments and application
// parameters: they can identify different articles, searches, or SPA routes.
function sourceKey(url) {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['gclid', 'fbclid', 'msclkid', 'dclid'].includes(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.href;
}
function sourcesFor(session) {
  const groups = new Map();
  for (const item of session.events) {
    if (!['page_visit', 'tab_switch', 'highlight'].includes(item.type) || !webURL(item.url)) continue;
    const key = sourceKey(item.url);
    if (!groups.has(key)) groups.set(key, { id: key, url: item.url, title: item.title || item.url, visits: 0, highlights: 0 });
    const source = groups.get(key);
    if (item.type === 'highlight') source.highlights++;
    else source.visits++;
  }
  return [...groups.values()];
}

function report(error) {
  console.warn('MindTrail:', error.message || String(error));
  // Badge/title feedback remains visible when the popup is closed.
  void feedback(error.message || 'Unable to save activity.', true).catch(() => {});
}

async function handleMessage(message) {
  const state = await readState();
  switch (message.action) {
    case 'GET_STATE':
      return { success: true, state };
    case 'START_SESSION': {
      const name = typeof message.name === 'string' ? message.name.trim() : '';
      if (!name || name.length > 120) throw new Error('Enter a session name between 1 and 120 characters.');
      if (!Number.isInteger(message.windowId) || message.windowId < 0) throw new Error('A valid Chrome window is required.');
      if (state.activeSessionId !== null) throw new Error('A research session is already active. Stop it before starting another.');
      const durationMinutes = duration(message.durationMinutes);
      const window = await chrome.windows.get(message.windowId);
      if (window.type !== 'normal') throw new Error('Start research in a normal browser window.');
      const tabs = await chrome.tabs.query({ active: true, windowId: message.windowId });
      const session = {
        id: crypto.randomUUID(), name, windowId: message.windowId,
        startedAt: new Date().toISOString(), endedAt: null, durationMinutes,
        stopAt: new Date(Date.now() + durationMinutes * MINUTE).toISOString(),
        events: [event('session_started')]
      };
      if (tabs[0] && webURL(tabs[0].url)) session.events.push(event('page_visit', tabs[0]));
      state.sessions.push(session);
      state.activeSessionId = session.id;
      await saveState(state);
      await ensureTimer(state);
      await feedback('Recording research').catch(() => {});
      return { success: true, sessionId: session.id };
    }
    case 'STOP_SESSION': {
      const session = activeSession(state);
      if (!session) throw new Error('There is no active research session.');
      finishSession(state, session, 'manual');
      await saveState(state);
      await ensureTimer(state);
      await feedback('Research saved').catch(() => {});
      return { success: true };
    }
    case 'SAVE_RESEARCH_BRIEF': {
      const session = findSession(state, message.sessionId);
      const input = validateBriefInput(message.input);
      verifyBriefSnapshot(input, session);
      const result = validateBriefResult(message.result, input);
      session.researchBrief = { version: 1, generatedAt: new Date().toISOString(), input, result };
      await saveState(state);
      return { success: true, brief: session.researchBrief };
    }
    case 'UPDATE_EXPLANATION': {
      const session = findSession(state, message.sessionId);
      const highlight = session.events.find(item => item.id === message.eventId && item.type === 'highlight');
      if (!highlight) throw new Error('Highlight not found in this session.');
      const fields = ['term', 'simpleExplanation', 'example', 'keyTakeaway'];
      const explanation = message.explanation;
      if (!explanation || typeof explanation !== 'object' || Array.isArray(explanation) ||
          !fields.every(field => typeof explanation[field] === 'string' && explanation[field].trim())) {
        throw new Error('Explanation must contain term, simpleExplanation, example and keyTakeaway as nonempty text.');
      }
      highlight.explanation = Object.fromEntries(fields.map(field => [field, explanation[field]]));
      highlight.status = 'ready';
      await saveState(state);
      return { success: true };
    }
    case 'EXTEND_SESSION': {
      const session = activeSession(state);
      if (!session || session.id !== message.sessionId) throw new Error('This recording has ended. Start a new session.');
      session.stopAt = new Date(Date.parse(session.stopAt) + 60 * MINUTE).toISOString();
      session.limitWarningAt = null;
      await saveState(state);
      await ensureTimer(state);
      await feedback('Recording extended by 1 hour').catch(() => {});
      return { success: true, stopAt: session.stopAt };
    }
    case 'GET_RESTORE_SOURCES': {
      const session = findSession(state, message.sessionId);
      return { success: true, name: session.name, sources: sourcesFor(session) };
    }
    case 'RESTORE_SESSION': {
      const session = findSession(state, message.sessionId);
      if (!sourcesFor(session).length) throw new Error('This session has no web sources to restore.');
      await chrome.tabs.create({ url: chrome.runtime.getURL(`restore.html?sessionId=${encodeURIComponent(session.id)}`) });
      return { success: true, sourcesOpened: 0, message: 'Choose your sources in the restore checklist. Each click opens at most 10 tabs.' };
    }
    case 'RESTORE_BATCH': {
      const session = findSession(state, message.sessionId);
      if (!Array.isArray(message.sourceIds) || !message.sourceIds.length || message.sourceIds.length > 10) {
        throw new Error('Select between 1 and 10 sources per batch.');
      }
      const ids = new Set(message.sourceIds);
      const sources = sourcesFor(session).filter(source => ids.has(source.id));
      if (sources.length !== ids.size) throw new Error('A selected source is no longer available. Refresh the checklist.');
      // Open the original first-seen URLs: signed/query-sensitive URLs are not rewritten.
      await chrome.windows.create({ url: sources.map(source => source.url), type: 'normal' });
      return { success: true, sourcesOpened: sources.length };
    }
    case 'DELETE_SESSION': {
      findSession(state, message.sessionId);
      state.sessions = state.sessions.filter(item => item.id !== message.sessionId);
      if (state.activeSessionId === message.sessionId) state.activeSessionId = null;
      await saveState(state);
      await ensureTimer(state);
      await feedback('Session deleted').catch(() => {});
      return { success: true };
    }
    default:
      throw new Error('Unknown MindTrail action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ success: false, error: 'Only MindTrail pages can use this API.' });
    return false;
  }
  if (!message || !ACTIONS.has(message.action)) {
    sendResponse({ success: false, error: 'Unknown MindTrail action.' });
    return false;
  }
  serialize(() => handleMessage(message)).then(sendResponse, error => {
    sendResponse({ success: false, error: error.message || 'MindTrail could not complete this action.' });
  }).catch(report);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // URL changes catch navigations; completed loads supply redirects and titles.
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const snapshot = { id: tabId, windowId: tab.windowId, title: tab.title, url: changeInfo.url || tab.url };
  void serialize(async () => {
    const state = await readState();
    const session = activeSession(state);
    if (!session || snapshot.windowId !== session.windowId || !webURL(snapshot.url)) return;
    if (lastVisit(session, tabId)?.url === snapshot.url) return;
    session.events.push(event('page_visit', snapshot));
    await saveState(state);
  }).catch(report);
});

chrome.tabs.onActivated.addListener(info => {
  void serialize(async () => {
    const state = await readState();
    const session = activeSession(state);
    if (!session || info.windowId !== session.windowId) return;
    let tab;
    try { tab = await chrome.tabs.get(info.tabId); }
    catch { return; } // A tab can close before Chrome delivers its activation.
    if (tab.windowId !== session.windowId || !webURL(tab.url)) return;
    const previous = session.events.findLast(item => ['tab_switch', 'page_visit'].includes(item.type));
    if (previous?.tabId === tab.id && previous.url === tab.url) return;
    session.events.push(event('tab_switch', tab));
    await saveState(state);
  }).catch(report);
});

async function registerMenu() {
  await chrome.contextMenus.removeAll();
  await new Promise((resolve, reject) => {
    chrome.contextMenus.create({
      id: MENU_ID, title: 'Save to MindTrail', contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve();
    });
  });
}
chrome.runtime.onInstalled.addListener(() => { void registerMenu().catch(report); });
chrome.runtime.onStartup.addListener(() => { void registerMenu().catch(report); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  void serialize(async () => {
    const state = await readState();
    const session = activeSession(state);
    if (!session) throw new Error('Start Research in the MindTrail popup before saving highlights.');
    const selectedText = typeof info.selectionText === 'string' ? info.selectionText.trim().slice(0, 3000) : '';
    if (!selectedText) throw new Error('Select some text before saving a highlight.');
    if (!tab || tab.windowId !== session.windowId) throw new Error('Save highlights from the window where research was started.');
    const url = info.frameUrl || info.pageUrl || tab.url;
    if (!webURL(url)) throw new Error('Highlights can only be saved from HTTP or HTTPS pages.');
    session.events.push(event('highlight', { ...tab, url }, { selectedText, status: 'pending' }));
    await saveState(state);
    await feedback('Highlight saved').catch(() => {});
  }).catch(report);
});

// Reconcile persisted deadlines on every worker restart and browser startup.
// Timers are wake-up hints; every recording/message path also checks stopAt.
function initializeRecording() {
  return serialize(async () => {
    const state = await readState();
    await ensureTimer(state);
    await feedback(activeSession(state) ? 'Recording research' : state.sessions.at(-1)?.endReason === 'time_limit'
      ? 'Time limit reached. Recording stopped; all research is saved.' : 'Ready for research');
  });
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === TIMER) void initializeRecording().catch(report);
});
chrome.runtime.onStartup.addListener(() => { void initializeRecording().catch(report); });
chrome.notifications.onClicked.addListener(id => {
  if (id.startsWith('mindtrail-')) {
    void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') }).catch(report);
  }
});
void initializeRecording().catch(report);
