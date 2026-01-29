# Agent Control Panel (ACP)

Agent Control Panel (ACP) is a local-first, mobile-first control panel for browser automation jobs driven by CSV rows. It uses a Vite + React frontend with localStorage persistence and a companion Tampermonkey userscript for browser-side automation.

## Features
- Upload CSVs, create jobs, and manage workflows locally.
- Step-based workflows with retries, per-step timeouts, and best-effort mode.
- Resume from the last completed row.
- CSV import/export with post option selection to avoid duplicates.
- Interop with BroadcastChannel, window.postMessage, and localStorage fallbacks.
- Debug logging toggle for verbose automation logs.

## Project Structure
```
app/           # Vite + React frontend
shared/        # Shared schema + helpers
userscript/    # Tampermonkey automation script
examples/      # Sample CSVs
tests/         # Minimal tests
```

## Local Setup
```bash
npm install
npm run dev
```

Open the app at `http://localhost:5173`.

## Build for Production
```bash
npm run build
npm run preview
```

The static site outputs to `dist/`.

## Userscript Setup
1. Install Tampermonkey (or a compatible userscript manager).
2. Create a new userscript and paste `userscript/agent.user.js`.
3. Open Facebook or the target site.
4. In ACP, create a workflow and start a run. The userscript listens for control messages and executes steps.

## CSV Format
Required:
- `url` (used by the default workflow)

Optional:
- `post` (single post text)
- `post_options` (pipe-separated options to avoid duplicates)

Example:
```
url,post,post_options
https://example.com,Hello world,"Hello world|New promo drop|Limited offer"
```

If `post_options` is provided, ACP selects a non-duplicate option that is less than 80% similar to recent posts. When no unique option exists, ACP falls back to the first entry.

## Workflow Steps
Supported step types:
`goto`, `click`, `type`, `press`, `wait_for_selector`, `wait_time`, `screenshot`,
`evaluate`, `set_var`, `conditional`.

Templating:
- Use `{{field}}` to substitute CSV row fields.
- Missing fields fail the row with a human-readable error message.

## Render Deployment
This project is a static Vite app suitable for Render.

```bash
npm install
npm run build
```

Set the publish directory to `dist`.

## Health Check
Use the Settings tab to verify the UI is responsive; all data is local-first with localStorage persistence.

## Sample Data
See `examples/sample.csv`.
