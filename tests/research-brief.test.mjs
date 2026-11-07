import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { collectBriefSources, validateBriefInput, validateBriefResult, verifyBriefSnapshot } from '../extension/brief-contract.mjs';
import { fixtureSession, fixtureInput, fixtureResult, createWorkerHarness } from './brief-fixtures.mjs';

test('groups tracking variants, keeps exact passages and omits visited-only pages', () => {
  const sources = collectBriefSources(fixtureSession());
  assert.equal(sources.length, 2); assert.equal(sources[0].passages.length, 2);
  assert.equal(sources[0].passages[1].text, fixtureSession().events[1].selectedText);
});
test('rejects empty questions, invalid URLs, duplicate IDs, and oversized evidence', () => {
  assert.throws(() => validateBriefInput({ ...fixtureInput(), question: ' ' }));
  const invalid = fixtureInput(); invalid.sources[0].url = 'javascript:alert(1)'; assert.throws(() => validateBriefInput(invalid));
  const duplicate = fixtureInput(); duplicate.sources[1].passages[0].id = 'p1'; assert.throws(() => validateBriefInput(duplicate));
  const huge = fixtureInput(); huge.sources[0].passages = Array.from({ length: 21 }, (_, i) => ({ id: `big-${i}`, text: 'x'.repeat(3000) })); assert.throws(() => validateBriefInput(huge), /60,000/);
});
test('validates source coverage and rejects invented or cross-source citations', () => {
  assert.equal(validateBriefResult(fixtureResult(), fixtureInput()).sources.length, 2);
  const invented = fixtureResult(); invented.findings[0].citations = ['not-saved']; assert.throws(() => validateBriefResult(invented, fixtureInput()));
  const cross = fixtureResult(); cross.sources[0].citations = ['p3']; assert.throws(() => validateBriefResult(cross, fixtureInput()));
  const missing = fixtureResult(); missing.sources.pop(); assert.throws(() => validateBriefResult(missing, fixtureInput()));
});
test('accepts uncited outline gaps but requires evidence for findings and signals', () => {
  assert.deepEqual(validateBriefResult(fixtureResult(), fixtureInput()).outline[1].citations, []);
  const noEvidence = fixtureResult(); noEvidence.findings[0].citations = []; assert.throws(() => validateBriefResult(noEvidence, fixtureInput()));
  const fabricatedSignal = fixtureResult(); fabricatedSignal.sources[0].signals = [{ text: 'Peer reviewed', citations: [] }]; assert.throws(() => validateBriefResult(fabricatedSignal, fixtureInput()));
});
test('checks submitted snapshots against original saved evidence', () => {
  verifyBriefSnapshot(fixtureInput(), fixtureSession());
  const altered = fixtureInput(); altered.sources[0].passages[0].text = 'Altered quote'; assert.throws(() => verifyBriefSnapshot(altered, fixtureSession()));
});
test('worker persists validated briefs, survives restart and rejects deleted sessions', async () => {
  const worker = createWorkerHarness();
  const payload = { action: 'SAVE_RESEARCH_BRIEF', sessionId: 'session-research', input: fixtureInput(), result: fixtureResult() };
  const saved = await worker.send(payload); assert.equal(saved.success, true); assert.ok(saved.brief.generatedAt);
  worker.boot(); const read = await worker.send({ action: 'GET_STATE' });
  assert.equal(read.state.sessions[0].researchBrief.input.question, payload.input.question);
  const bad = structuredClone(payload); bad.input.sources[0].passages[0].text = 'Fabricated';
  assert.equal((await worker.send(bad)).success, false);
  assert.equal(worker.state().sessions[0].researchBrief.input.sources[0].passages[0].text, payload.input.sources[0].passages[0].text);
  await worker.send({ action: 'DELETE_SESSION', sessionId: 'session-research' });
  assert.equal((await worker.send(payload)).success, false);
});
test('structured highlight explanations remain compatible', async () => {
  const worker = createWorkerHarness();
  const explanation = { term: 'Sleep', simpleExplanation: 'Rest', example: 'Nightly sleep', keyTakeaway: 'Check context' };
  assert.equal((await worker.send({ action: 'UPDATE_EXPLANATION', sessionId: 'session-research', eventId: 'p1', explanation })).success, true);
});
async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(resolve => server.close(resolve)); }
}
const post = (base, body) => fetch(`${base}/api/research-brief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('HTTP endpoint returns validated results and rejects malformed input before generation', async () => {
  let calls = 0;
  await withServer(createApp(undefined, async input => { calls++; return fixtureResult(input); }), async base => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const response = await post(base, fixtureInput()); assert.equal(response.status, 200); assert.equal((await response.json()).findings.length, 1);
    assert.equal((await post(base, { ...fixtureInput(), question: '' })).status, 400); assert.equal(calls, 1);
    const big = fixtureInput(); big.sources[0].passages = Array.from({ length: 10 }, (_, i) => ({ id: `long-${i}`, text: 'x'.repeat(3000) }));
    assert.equal((await post(base, big)).status, 200); // Larger than the explanation endpoint's 20 KB.
    const invalidJSON = await fetch(`${base}/api/research-brief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(invalidJSON.status, 400);
  });
});
test('HTTP endpoint rejects malformed model responses', async () => {
  await withServer(createApp(undefined, async () => ({ findings: [] })), async base => {
    const response = await post(base, fixtureInput()); assert.equal(response.status, 502); assert.equal((await response.json()).code, 'BRIEF_INVALID_RESPONSE');
  });
});
test('missing Gemini credentials produce actionable failure without a provider call', async () => {
  const before = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try { await withServer(createApp(), async base => { const response = await post(base, fixtureInput()); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'GEMINI_KEY_MISSING'); }); }
  finally { if (before !== undefined) process.env.GEMINI_API_KEY = before; }
});
