import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { pathToFileURL } from 'node:url';
import { explainWithGemini } from './gemini.js';

export function createApp(explain = explainWithGemini) {
  const app = express();
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    }
  }));
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
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    const missingKey = error.status === 503;
    res.status(missingKey ? 503 : 502).json({ error: missingKey ? error.message : 'Gemini could not generate an explanation. Check your API key, quota and connection, then retry.' });
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT) || 3001, '127.0.0.1', () => console.log('MindTrail API listening on http://localhost:' + (process.env.PORT || 3001)));
}
