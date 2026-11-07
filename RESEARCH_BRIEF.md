# Research briefs

Research brief is an action on each dashboard session, not a separate recording mode.

## Run locally

Use Node.js 20 or newer. In `server/`, run `npm ci`, configure `GEMINI_API_KEY` in your local `.env` (see `.env.example`), then run `npm start`. Restart the backend after pulling this feature. The existing `GEMINI_MODEL` setting applies to both explanations and briefs.

Load or reload `extension/` at `chrome://extensions`. Open the dashboard, choose a session, and click **Research brief**. Version 1.2.0 includes this feature.

1. Save highlights while recording a session. Visited pages without saved text are excluded from briefs.
2. Enter an assignment prompt or research question.
3. Select sources and expand their saved passages to review what will be sent.
4. Click **Generate research brief**. Only this action sends the selected passages, titles, URLs, and prompt to the local API and Gemini.
5. Review findings, source comparisons, verification checks, an outline, and evidence gaps. Numbered links jump to exact saved passages and their original source URLs.

A brief supports up to 20 sources, 60 passages, and 60,000 passage characters; the prompt is limited to 2,000 characters. The first 10 sources are initially selected. Tracking variants of the same URL are grouped. The original first-seen source URL is retained.

## Evidence and persistence

This version analyzes saved excerpts, not full articles. It does not browse, verify publication records, check peer review, or generate formal bibliographic citations. All sources are explicitly marked as not independently verified. Relevance and credibility clues are model assessments, with concrete checks for the student to perform. Citation validation ensures a referenced passage exists and belongs to the indicated source; it cannot prove that a model's interpretation is correct.

The background worker alone writes `mindtrailState`. Each session can have an optional `researchBrief` containing version, generation time, input snapshot, and validated result. A successful regeneration replaces the prior brief; failed generation leaves it intact. New highlights require refreshing the evidence selection and regenerating. If saving fails, the generated draft remains on the open page with a save-only retry. Closing that page loses an unsaved draft.

The backend exposes `POST /api/research-brief` with `{question, sources}`; each source has `{id, title, url, passages: [{id, text}]}`. `extension/brief-contract.mjs` defines input/output bounds and citation validation. The service worker accepts `SAVE_RESEARCH_BRIEF` with `{sessionId, input, result}`, verifies passages against stored highlights, and assigns the save timestamp.

## Validation

After installing backend dependencies, run from the repository root:

```sh
node --test tests/research-brief.test.mjs
```

The tests use controlled model outputs: they cover grouping, input limits, citation validation, tampered evidence, persistence across worker restart, deleted sessions, existing explanation compatibility, HTTP routes, invalid model results, and missing credentials. A live Gemini response still requires a configured API key.

Manual checks:

- Generate a brief from two sources, follow a citation, and confirm its quote matches the saved selection.
- Reopen the page and confirm the saved prompt and report remain.
- Try an unrelated question; inspect low-relevance assessments and research gaps rather than treating the results as verified facts.
- Stop the backend and retry generation; the previous brief should remain.
- Cancel a request; the prior saved brief should remain. Cancellation stops the client from saving that result; a provider request already in flight may still finish.
