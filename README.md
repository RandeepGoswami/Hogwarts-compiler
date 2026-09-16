# 🪄 Department of Magical Syntax

An interactive, Harry-Potter-themed compiler pipeline sandbox: a real
deterministic lexer/parser/type-checker/codegen in the backend, plus an
**AI agent** that explains type errors and suggests optimizations, live.

## AI agent: powered by the OpenAI API

The AI agent calls the OpenAI API (`https://api.openai.com/v1/chat/completions`)
directly, authenticated with your own `OPENAI_API_KEY`. Any OpenAI
chat-completion model works (`gpt-4o-mini` by default, or `gpt-4o`,
`gpt-4.1`, etc. — see your account's available models at
<https://platform.openai.com/docs/models>).

## Architecture

```
hogwarts-compiler/
├── backend/          Express API — deterministic pipeline + AI agent calls
│   ├── server.js
│   ├── package.json
│   └── .env.example
├── frontend/          Static Hogwarts-themed UI (no build step)
│   └── index.html
├── render.yaml        Render blueprint for the backend
├── vercel.json         Vercel config for the frontend
└── .gitignore
```

- **Type checking & code generation** are done with real, deterministic
  JavaScript in `backend/server.js` — this is how an actual compiler
  works, and it's honest to keep it that way.
- **The AI agent** (via the OpenAI API) is called for the two tasks that
  genuinely need language understanding: explaining *why* a type error
  happened in a friendly way, and proposing a register-allocation-style
  optimization with a written rationale.
- If no `OPENAI_API_KEY` is configured, both AI endpoints gracefully fall
  back to canned responses so the app still works for a demo.

## 1. Local setup

```bash
git clone <your-repo-url>
cd hogwarts-compiler/backend
npm install
cp .env.example .env
# edit .env and paste in your OpenAI API key
npm start
```

Then just open `frontend/index.html` directly in a browser (or serve it
with any static server) — it talks to `http://localhost:4000` by default.

### Getting an OpenAI API key

1. Go to <https://platform.openai.com/api-keys> and create a new secret key.
2. Copy the key into `backend/.env` as `OPENAI_API_KEY`.
3. Pick a model from <https://platform.openai.com/docs/models> and set
   `OPENAI_MODEL` accordingly (default: `gpt-4o-mini`).
4. Make sure your OpenAI account/project has billing set up — the Chat
   Completions API is a paid endpoint (no free tier), and requests will
   fail with an `api_error` in the health check / fallback responses if
   the key is invalid or has no credit.

## 2. Deploy the backend to Render

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint**, point it at your repo — it will
   read `render.yaml` automatically and create the `hogwarts-compiler-backend`
   web service (root directory `backend`).
3. In the Render dashboard, set the `OPENAI_API_KEY` environment variable
   (marked `sync: false` in the blueprint, so Render will prompt you for
   it — never commit real keys).
4. Deploy. Note the resulting URL, e.g.
   `https://hogwarts-compiler-backend.onrender.com`.

## 3. Deploy the frontend to Vercel

1. In Vercel, **Add New → Project**, import the same repo.
2. Vercel will pick up `vercel.json`, which serves the `frontend/`
   directory as static output — no build step needed.
3. Before or after deploying, open `frontend/index.html` and set the API
   base to your live Render URL, either by editing this line directly:
   ```js
   const API_BASE = window.HOGWARTS_API_BASE || 'http://localhost:4000';
   ```
   or (recommended, so you don't hardcode it) by adding a tiny inline
   script above it in `index.html`:
   ```html
   <script>window.HOGWARTS_API_BASE = 'https://hogwarts-compiler-backend.onrender.com';</script>
   ```
4. Deploy. Vercel gives you a URL like
   `https://hogwarts-compiler.vercel.app`.

## 4. CORS

The backend already has `cors()` enabled for all origins, so the Vercel
frontend can call the Render backend cross-origin without extra config.
If you want to lock it down for the final submission, restrict it in
`server.js`:

```js
app.use(cors({ origin: 'https://hogwarts-compiler.vercel.app' }));
```

## Extending it

- Add more type-error categories to `typeCheck()` in `server.js`.
- Have the AI agent also review whole-function control flow, not just
  single declarations.
- Swap `gpt-4o-mini` for a larger model (e.g. `gpt-4o`) if you want richer
  optimization commentary (trade-off: slower, more expensive per call).
