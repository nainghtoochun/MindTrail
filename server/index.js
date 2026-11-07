import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'node:url';
import { explainWithGemini } from './gemini.js';
import { briefWithGemini } from './brief.js';
import { validateBriefInput, validateBriefResult } from '../extension/brief-contract.mjs';

export function createApp(explain = explainWithGemini, generateBrief = briefWithGemini) {
  const app = express();
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    }
  }));
  app.use('/api/research-brief', express.json({ limit: '512kb' }));
  app.use(express.json({ limit: '20kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'mindtrail-api' }));
  app.post('/api/explain', async (req, res, next) => {
    const { selectedText, pageTitle, pageUrl, level = 'beginner' } = req.body || {};
    if (typeof selectedText !== 'string' || !selectedText.trim() || selectedText.length > 3000) {
      return res.status(400).json({ error: 'selectedText must be a non-empty string of at most 3,000 characters.' });
    }
    for (const [key, value, max] of [['pageTitle', pageTitle, 1000], ['pageUrl', pageUrl, 4096], ['level', level, 40]]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > max)) return res.status(400).json({ error: `${key} must be a string of at most ${max} characters.` });
    }
    try { res.json(await explain({ selectedText, pageTitle, pageUrl, level })); }
    catch (error) { next(error); }
  });
  app.post('/api/research-brief', async (req, res, next) => {
    let input;
    try { input = validateBriefInput(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const generated = await generateBrief(input);
      let result;
      try { result = validateBriefResult(generated, input); }
      catch { return res.status(502).json({ error: 'The brief contained incomplete or unsupported evidence references. Please retry.', code: 'BRIEF_INVALID_RESPONSE' }); }
      res.json(result);
    } catch (error) { next(error); }
  });
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    // Classify provider errors without exposing raw responses, selected text or credentials.
    const status = Number(error.status || error.statusCode);
    const detail = String(error.message || '');
    let code = 'GEMINI_REQUEST_FAILED';
    let message = 'The Gemini request failed. Check the backend connection and retry.';
    let httpStatus = 502;
    if (detail === 'Configure GEMINI_API_KEY in server/.env before requesting explanations.') {
      code = 'GEMINI_KEY_MISSING';
      message = 'Set GEMINI_API_KEY in server/.env, save the file, then restart the backend.';
      httpStatus = 503;
    } else if (/API_KEY_INVALID|API key not valid|API key expired/i.test(detail) || status === 401) {
      code = 'GEMINI_KEY_INVALID';
      message = 'Google rejected the API key. Replace GEMINI_API_KEY with a valid Google AI Studio key, save .env, then restart the backend.';
    } else if (status === 429 || /RESOURCE_EXHAUSTED/i.test(detail)) {
      code = 'GEMINI_QUOTA_EXCEEDED';
      message = 'Google reports a rate or quota limit. Check this API key project’s limits in Google AI Studio. If the limit is zero, waiting will not help; the project needs access or quota for the configured model. Otherwise wait and retry.';
      httpStatus = 429;
    } else if (status === 403) {
      code = 'GEMINI_ACCESS_DENIED';
      message = 'Google denied access. Check the API key restrictions, project API access and regional availability in Google AI Studio.';
    } else if (status === 404) {
      code = 'GEMINI_MODEL_UNAVAILABLE';
      message = 'The configured Gemini model was not found for this request. Check GEMINI_MODEL in server/.env against the models available to your project, then restart the backend.';
    } else if (status === 400) {
      code = 'GEMINI_REQUEST_REJECTED';
      message = 'Google rejected the request settings. Check that GEMINI_MODEL supports structured JSON output and that the API key is valid.';
    } else if (status >= 500) {
      code = 'GEMINI_TEMPORARILY_UNAVAILABLE';
      message = 'Google Gemini is temporarily unavailable. Wait a moment and retry.';
      httpStatus = 503;
    } else if (/timeout|timed out|abort/i.test(detail) || error.name === 'AbortError') {
      code = 'GEMINI_TIMEOUT';
      message = 'Google Gemini did not respond in time. Check your internet connection and retry.';
      httpStatus = 504;
    } else if (error instanceof SyntaxError || /invalid explanation/i.test(detail)) {
      code = 'GEMINI_INVALID_RESPONSE';
      message = 'Gemini returned an incomplete or invalid explanation. Please retry.';
    }
    console.warn(`[MindTrail] ${code}${Number.isFinite(status) ? ` (provider HTTP ${status})` : ''}`);
    res.status(httpStatus).json({ error: message, code });
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT) || 3001, '127.0.0.1', () => console.log('MindTrail API listening on http://localhost:' + (process.env.PORT || 3001)));
}
