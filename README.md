# Cardiac Surgery Literature — standalone app

A live literature search tool (recent feed + on-demand search) that lives outside Claude, at its own URL you can bookmark or add to your iPad home screen.

## How it works
- `index.html` — the app itself, no build step, no framework.
- `api/search.js` — a small serverless function that holds your Anthropic API key server-side and calls Claude (with web search enabled) on the app's behalf. Your key never touches the browser.

## What you need
- An Anthropic API key (separate from your claude.ai login) — get one at **console.anthropic.com → API Keys**. This is billed per use, not part of a Claude subscription. Cost is small: each search is roughly a couple cents.
- A free Vercel account (or Netlify — steps are nearly identical) — **vercel.com**.
- A free GitHub account, to hold the files so Vercel can deploy them.

Everything below can be done from a browser, including on an iPad.

## Deploy steps

1. **Create a GitHub repo**
   - Go to github.com → New repository → name it e.g. `cardiac-lit-app` → Create.
   - On the repo page, click "uploading an existing file" and upload all three files here (`index.html`, `api/search.js`, `package.json`), keeping `api/search.js` inside an `api` folder.

2. **Get your Anthropic API key**
   - console.anthropic.com → API Keys → Create Key. Copy it — you won't see it again.

3. **Deploy on Vercel**
   - vercel.com → sign in with GitHub → "Add New… → Project" → import the `cardiac-lit-app` repo.
   - Before deploying, expand "Environment Variables" and add:
     - Name: `ANTHROPIC_API_KEY`
     - Value: (paste your key)
   - Click Deploy.

4. **Use it**
   - Vercel gives you a URL like `cardiac-lit-app.vercel.app`.
   - On iPad Safari: open it, tap Share → "Add to Home Screen" for an app-like icon.

## Updating later
Any time you want to change the design or behavior, edit `index.html` or `api/search.js` in the GitHub repo (or push new files) — Vercel redeploys automatically on every commit.

## Cost control
There's no rate limiting built in. If you want a ceiling, set a monthly spend cap in console.anthropic.com → Billing → Limits.
