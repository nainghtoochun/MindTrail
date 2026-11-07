import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import * as contract from '../extension/brief-contract.mjs';
export function fixtureSession() {
  return { id: 'session-research', name: 'Student sleep', windowId: 1, startedAt: '2026-11-07T12:00:00Z', endedAt: '2026-11-07T13:00:00Z', events: [
    { id: 'p1', type: 'highlight', title: 'Sleep study', url: 'https://example.org/study', selectedText: 'The authors report a survey of 100 students and an association between screen use and sleep duration.' },
    { id: 'p2', type: 'highlight', title: 'Sleep study', url: 'https://example.org/study?utm_source=email', selectedText: 'This observational survey cannot establish causation.' },
    { id: 'p3', type: 'highlight', title: 'Student opinion', url: 'https://example.net/opinion', selectedText: 'I sleep better when I stop checking messages at night.' },
    { id: 'v1', type: 'page_visit', url: 'https://example.com/no-highlight' }
  ] };
}
export function fixtureInput() { return { question: 'What evidence links screen use to student sleep?', sources: contract.collectBriefSources(fixtureSession()) }; }
export function fixtureResult(input = fixtureInput()) {
  return { findings: [{ text: 'The excerpt reports an association; it does not establish causation.', citations: [input.sources[0].passages[0].id] }],
    sources: input.sources.map(source => ({ sourceId: source.id, relevance: 'high', reason: 'The saved passage discusses sleep.', citations: [source.passages[0].id], signals: [], checks: ['Check the original author, publication date, and study methods.'] })),
    outline: [{ heading: 'Evidence and its limitations', purpose: 'Discuss what the saved excerpt can support.', citations: [input.sources[0].passages[0].id] }, { heading: 'Alternative explanations', purpose: 'Find independent evidence before drafting this section.', citations: [] }],
    gaps: ['Seek independent studies and evaluate their methods.'] };
}
export function createWorkerHarness(initial = { activeSessionId: null, sessions: [fixtureSession()] }) {
  let state = structuredClone(initial), handler;
  const hooks = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`, onMessage: { addListener(fn) { handler = fn; } }, onInstalled: hooks(), onStartup: hooks() },
    storage: { local: { async get() { return { mindtrailState: structuredClone(state) }; }, async set(value) { state = structuredClone(value.mindtrailState); } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    alarms: { onAlarm: hooks(), async get() { return null; }, async create() {}, async clear() {} },
    notifications: { onClicked: hooks(), async create() {} },
    tabs: { onUpdated: hooks(), onActivated: hooks(), async create() {}, async query() { return []; } },
    windows: { async get() { return { type: 'normal' }; }, async create() {} },
    contextMenus: { onClicked: hooks(), async removeAll() {}, create(_, callback) { callback(); } }
  };
  function boot() {
    const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
    vm.runInNewContext(source, { chrome, crypto: webcrypto, URL, console, ...contract });
  }
  boot();
  return { boot, state: () => structuredClone(state), send: message => new Promise(resolve => handler(message, { id: 'test' }, resolve)) };
}
