'use strict';
const $ = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('sessionId');
let sources = [];
let busy = true;
const selected = new Set();
const opened = new Set();
async function request(action, extra = {}) {
  const result = await chrome.runtime.sendMessage({ action, sessionId, ...extra });
  if (!result?.success) throw new Error(result?.error || 'MindTrail could not complete this action.');
  return result;
}
function showError(error) {
  $('error').textContent = error.message;
  $('error').hidden = false;
}
function controls() {
  $('open').disabled = busy || !selected.size;
  $('open').textContent = `Open ${selected.size} selected source${selected.size === 1 ? '' : 's'}`;
  $('next').disabled = busy || opened.size === sources.length;
  $('clear').disabled = busy || !selected.size;
  $('status').textContent = `${sources.length} unique sources · ${selected.size} selected · ${opened.size} opened from this checklist`;
  document.querySelectorAll('#sources input').forEach(input => {
    input.checked = selected.has(input.value);
    input.disabled = busy || opened.has(input.value) || (!input.checked && selected.size >= 10);
  });
}
function selectNext() {
  selected.clear();
  sources.filter(source => !opened.has(source.id)).slice(0, 10).forEach(source => selected.add(source.id));
  controls();
}
function render() {
  $('sources').replaceChildren();
  sources.forEach((source, index) => {
    const row = document.createElement('div'); row.className = 'source';
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = `source-${index}`; input.value = source.id;
    input.addEventListener('change', () => {
      if (input.checked && selected.size < 10) selected.add(source.id); else selected.delete(source.id);
      controls();
    });
    const detail = document.createElement('div');
    const label = document.createElement('label'); label.htmlFor = input.id; label.textContent = source.title;
    const link = document.createElement('a'); link.href = source.url; link.textContent = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const counts = document.createElement('small'); counts.textContent = `${source.visits} visits / tab switches · ${source.highlights} highlights`;
    detail.append(label, link, counts); row.append(input, detail); $('sources').append(row);
  });
  controls();
}
$('sources').addEventListener('submit', event => event.preventDefault());
$('next').addEventListener('click', selectNext);
$('clear').addEventListener('click', () => { selected.clear(); controls(); });
$('open').addEventListener('click', async () => {
  if (busy || !selected.size) return;
  busy = true; $('error').hidden = true; controls();
  const batch = [...selected];
  try {
    await request('RESTORE_BATCH', { sourceIds: batch });
    batch.forEach(id => opened.add(id)); selected.clear();
  } catch (error) { showError(error); }
  finally { busy = false; controls(); }
});
(async () => {
  try {
    const result = await request('GET_RESTORE_SOURCES'); sources = result.sources;
    $('name').textContent = result.name; busy = false; render(); selectNext();
  } catch (error) { $('status').textContent = 'Sources could not be loaded. Reopen the checklist from your dashboard.'; showError(error); }
})();
