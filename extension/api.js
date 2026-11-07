export function isExplanation(value) {
  return value && ['term', 'simpleExplanation', 'example', 'keyTakeaway'].every(key => typeof value[key] === 'string' && value[key].trim());
}
export async function explainHighlight({ selectedText, pageTitle, pageUrl, level = 'beginner' }) {
  let response;
  try {
    response = await fetch('http://localhost:3001/api/explain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedText, pageTitle, pageUrl, level }),
      signal: AbortSignal.timeout(35000)
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'The explanation timed out. Please retry.' : 'Cannot reach MindTrail API. Start the backend on localhost:3001 and check extension host permissions.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The backend returned invalid JSON. Please retry.'); }
  if (!response.ok) throw new Error(data.error || 'Gemini is unavailable. Please retry.');
  if (!isExplanation(data)) throw new Error('The backend returned an incomplete explanation. Please retry.');
  return data;
}

export async function generateResearchBrief(input, signal) {
  let response;
  try {
    response = await fetch('http://localhost:3001/api/research-brief', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      signal: AbortSignal.any([signal, AbortSignal.timeout(55000)])
    });
  } catch (error) {
    if (signal.aborted) throw new DOMException('Generation cancelled.', 'AbortError');
    throw new Error(error.name === 'TimeoutError' ? 'The research brief timed out. Please retry.' : 'Cannot reach MindTrail API. Start the backend on localhost:3001.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The backend returned invalid JSON. Please retry.'); }
  if (!response.ok) throw new Error(data.error || 'The brief could not be generated. Please retry.');
  return data;
}
