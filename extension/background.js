'use strict';

const STATE_KEY = 'mindtrailState';
const MENU_ID = 'mindtrail-save';
const ACTIONS = new Set([
  'START_SESSION', 'STOP_SESSION', 'GET_STATE', 'UPDATE_EXPLANATION',
  'RESTORE_SESSION', 'DELETE_SESSION'
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

async function feedback(message, failed = false) {
  await Promise.all([
    chrome.action.setBadgeText({ text: failed ? '!' : '' }),
    chrome.action.setBadgeBackgroundColor({ color: failed ? '#b93848' : '#356859' }),
    chrome.action.setTitle({ title: `MindTrail — ${message}` })
  ]);
}

function report(error) {
  console.warn('MindTrail:', error.message || String(error));
  // Badge/title feedback needs no notifications permission and survives popup closure.
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
      const window = await chrome.windows.get(message.windowId);
      if (window.type !== 'normal') throw new Error('Start research in a normal browser window.');
      const tabs = await chrome.tabs.query({ active: true, windowId: message.windowId });
      const session = {
        id: crypto.randomUUID(), name, windowId: message.windowId,
        startedAt: new Date().toISOString(), endedAt: null,
        events: [event('session_started')]
      };
      if (tabs[0] && webURL(tabs[0].url)) session.events.push(event('page_visit', tabs[0]));
      state.sessions.push(session);
      state.activeSessionId = session.id;
      await saveState(state);
      void feedback('Recording research').catch(() => {});
      return { success: true, sessionId: session.id };
    }
    case 'STOP_SESSION': {
      const session = activeSession(state);
      if (!session) throw new Error('There is no active research session.');
      const ended = event('session_ended');
      session.events.push(ended);
      session.endedAt = ended.timestamp;
      state.activeSessionId = null;
      await saveState(state);
      void feedback('Research saved').catch(() => {});
      return { success: true };
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
    case 'RESTORE_SESSION': {
      const session = findSession(state, message.sessionId);
      const urls = [...new Set(session.events
        .filter(item => ['page_visit', 'tab_switch', 'highlight'].includes(item.type) && webURL(item.url))
        .map(item => item.url))];
      if (!urls.length) throw new Error('This session has no web sources to restore.');
      await chrome.windows.create({ url: urls, type: 'normal' });
      return { success: true, sourcesOpened: urls.length };
    }
    case 'DELETE_SESSION': {
      findSession(state, message.sessionId);
      state.sessions = state.sessions.filter(item => item.id !== message.sessionId);
      if (state.activeSessionId === message.sessionId) state.activeSessionId = null;
      await saveState(state);
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
    void feedback('Highlight saved').catch(() => {});
  }).catch(report);
});
