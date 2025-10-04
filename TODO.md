# VideoAI – TODO Roadmap

A living checklist of improvements and features. Grouped by area for clarity. Use it as a backlog; pick “Immediate” first.

## Immediate bugfixes & code hygiene
- [ ] Remove duplicate functions/endpoints in `main.py` (unify `create_rounded_rectangle_mask`/`add_curved_border` and the duplicated `/api/panel/add-border` route)
- [ ] Extract effect/transition constants into a single config source used by both server (`/api/effect-config`) and client (`video_editor.js`)
- [ ] Replace global `full_story_context` with per-project state stored in project data
- [ ] Normalize/sanitize upload filenames; prevent directory traversal; validate MIME and size
- [ ] Add consistent JSON error model (code, message, details) and raise `HTTPException` with that shape
- [ ] Guard env usage: handle missing `PANEL_API_URL`/`TTS_API_URL` gracefully with clear messages
- [ ] Ensure `.env` is git-ignored; rotate any committed secrets (API keys) immediately

## Backend API (FastAPI)
- [ ] Project persistence: concurrency-safe writes to `manga_projects/projects.json` (file lock/atomic write)
- [ ] Backups/versioning for projects; migration on load (schema version field)
- [ ] Export/import project as ZIP (metadata + assets in `uploads/`)
- [ ] Paginate/list `uploads/` with cleanup job (TTL-based GC)
- [ ] Async job queue for panel detection/tts/render with status; push SSE progress by job id
- [ ] Add `/api/health` and `/api/version` endpoints
- [ ] Rate limiting and CORS allowlist from `ALLOW_ORIGINS` env
- [ ] Enforce max upload size and allowed content types
- [ ] Pluggable providers for Panel API and TTS; provider health checks
- [ ] Optional cloud storage (S3/GCS/Azure) for assets; signed URL support
- [ ] Cache/skip recomputation via content hash (image+params, text+voice)

## Panel detection pipeline
- [ ] Robust `PANEL_API_MODE` fallback: auto → json → zip → image
- [ ] Debounce/dedupe per-page calls; idempotency keys
- [ ] Persist crop metadata (bbox, rotation, border style) per panel
- [ ] Manual annotation UI write-through: rectangles/freeform saved back to project
- [ ] Configurable add-border defaults (width/color/corner radius) per project

## TTS and audio
- [ ] Batch synthesis per page/panel with concurrency limits
- [ ] Voice selection, style, and SSML support
- [ ] Silence trimming and loudness normalization (EBU R128/LUFS)
- [ ] Background music support with ducking under narration; per-clip gain automation
- [ ] Caching by (text+voice+settings) hash; reuse from local/remote cache
- [ ] Audio format options (mp3/wav/opus) and sample rate resampling

## Video rendering
- [ ] Server-side rendering with MoviePy/ffmpeg to match client preview
- [ ] Deterministic timeline serialization (layers, transitions, easing)
- [ ] Expanded transitions: wipes (all directions), dip-to-black/white, zoom, page-turn polish
- [ ] Clip-level easing curves (linear/ease-in/ease-out/bezier)
- [ ] Render queue with statuses, retries, and artifact retention policy
- [ ] Output presets (FPS, resolution 9:16/16:9, bitrate, codec)
- [ ] Watermark toggle and safe-margin overlays

## Effect & transition config
- [ ] Single source of truth for EFFECT_* and TRANSITION_* values
- [ ] Range validation and presets (e.g., “Cinematic”, “Fast”, “Gentle”)
- [ ] Per-project overrides stored in project file and honored by preview/render

## Frontend – Manga View & Panel Editor
- [ ] Persist workflow steps state; derive from actual project data when possible
- [ ] Panel editor performance for large pages (virtualized list/grid)
- [ ] Drag/drop reordering across pages; keyboard shortcuts for move/copy
- [ ] Inline text editor with markdown and spellcheck; autosave
- [ ] Fullscreen carousel: zoom/pan and keyboard navigation; image preloading
- [ ] Toast/error patterns centralized and consistent

## Frontend – Video Editor (timeline/canvas)
- [ ] Undo/redo history (command stack)
- [ ] Snap to grid/markers; ripple edit and track reflow
- [ ] Multi-layer UI: add/remove/rename, lock/mute/solo, reorder tracks
- [ ] Inspector with numeric fields (position, scale, rotation, crop)
- [ ] Audio waveforms and measured clip durations from decoded metadata
- [ ] Robust autosave (visibilitychange, beforeunload, throttle)
- [ ] Preload manager UI for images/audio with progress
- [ ] Export dialog UX for presets; validation
- [ ] Background layer management; per-track volume envelopes/keyframes
- [ ] Mobile/touch gestures for move/scale/crop

## Data & storage
- [ ] Move from flat JSON to SQLite for projects (with migrations)
- [ ] Hash-based deduplication of assets; per-project asset folders
- [ ] Orphaned asset garbage collection and disk quota enforcement
- [ ] Index `manga_projects/*` for quick search/filter by title/date

## Security & privacy
- [ ] Authentication (session/JWT) and per-project authorization
- [ ] CSRF protection for mutating routes (if using cookies)
- [ ] Content Security Policy headers; strict static serving
- [ ] PII logging policy and audit trail for data operations
- [ ] Secure secrets management (env only; no secrets in repo)

## Observability
- [ ] Structured logging (json) with request/job IDs; log correlation across SSE
- [ ] Metrics (Prometheus/OpenTelemetry): request latency, queue length, render durations
- [ ] Error tracking (Sentry) for backend and frontend

## Testing & quality
- [ ] Unit tests for parsers (`parse_json_array_from_text`, `normalize_panel_id`, etc.)
- [ ] API tests for upload, panel detection, tts, save_project
- [ ] Frontend smoke tests (Playwright) for key flows
- [ ] Lint/format: Ruff/Black/isort for Python; ESLint/Prettier for JS
- [ ] Type checking: mypy for Python, JSDoc/TypeScript types for JS

## DevOps & delivery
- [ ] Dockerfile and docker-compose for dev/prod
- [ ] CI: install deps, lint, test, build, publish artifacts
- [ ] Production server: gunicorn+uvicorn workers behind reverse proxy
- [ ] Static asset caching and compression
- [ ] VS Code tasks/launch configs polished for common workflows

## UX & accessibility
- [ ] Keyboard shortcuts cheat-sheet and tooltips
- [ ] Focus management and ARIA roles for modals/editors
- [ ] Color contrast audit and prefers-reduced-motion support
- [ ] i18n scaffolding and language switcher

## Documentation
- [ ] README: setup, environment vars, common flows, troubleshooting
- [ ] API reference with request/response examples
- [ ] Contribution guide and code style conventions
- [ ] CHANGELOG and release notes

## Nice-to-haves
- [ ] AI narration generation from panels using Gemini with prompt templates
- [ ] Auto timing panels from TTS durations; adaptive pacing
- [ ] Background music library (moods/genres) with auto-fit
- [ ] Cloud export (YouTube/Drive) with webhooks
- [ ] Offline-first panel editor (IndexedDB) with sync on reconnect

## Cleanup
- [ ] Remove dead/commented code; favor feature flags for optional pieces
- [ ] Consolidate rounded mask/border utilities into a single module
- [ ] Rename ambiguous variables and add docstrings where missing
- [ ] Separate dev-only ngrok headers from production builds

---

Tips:
- Tackle Immediate first, then pick one area per iteration.
- Add a “Done” section per sprint to keep momentum visible.

## Connected Stories & Character Memory

Introduce a way to link projects in a series and carry forward narrative context and character knowledge. This enables richer, coherent storytelling across chapters while remaining token- and performance-aware.

### Features
- [ ] Project linking model and API
	Create `previous_project_id`, `next_project_id`, and `series_id` in project metadata. Add endpoints to link/unlink and validate the chain. This lets a project reference its predecessor and belong to a series for cross-project queries.
	Serialize link info in `manga_projects/projects.json` with an explicit `schema_version`; use atomic writes to avoid corruption.

- [ ] Character registry per project (Main & Recurring)
	Extend project schema with `characters: { main: Character[], recurring: Character[] }`. A Character has `id`, `name`, `aliases[]`, `description`, `traits[]`, `voice`, `images[]`, and optional `notes`.
	Add CRUD endpoints and a UI “Character Manager” to edit, import/export, and reorder characters. Persist with migrations for existing projects.

- [ ] Narrative generation with prior-context
	When calling `/api/manga/{project_id}/narrative`, assemble a “context bundle” from the linked previous project: last chapter recap, character sheets, and optionally last N page summaries.
	Respect model token limits by summarizing older content, trimming to budget, and tagging sources. Provide a toggle “Use previous story as context”.

- [ ] Character propagation across linked projects
	On creating a new linked project, offer to import characters from the previous one. Track canonical characters by `character_id` across a series and allow per-project overrides (e.g., updated description/voice).
	Detect probable duplicates via name/alias similarity and suggest merges, keeping a change log.

- [ ] Context assembly strategy and templates
	Define a prompt template with sections: Recap, Character Sheet (Main first, then Recurring), and Current Page Hints. Allow per-project weights (e.g., more emphasis on characters).
	Expose settings via `/api/effect-config`-like endpoint or a new `/api/story-config`; cache the final assembled prompt for repeat runs.

- [ ] UI: Link controls and Character Manager
	In `manga_view.html`, add a “Connected Story” panel: select previous project, show series info, and a “Open Character Manager” button. Display current link status and quick jump to previous.
	Add inline character chips on pages for quick reference; support tooltips with description/traits and an edit shortcut.

- [ ] Context caching and invalidation
	Cache a computed context bundle (recap + character sheet) per project. Invalidate when the previous project’s narration or character data changes, or when link settings are updated.
	Store cache metadata (source hashes, token counts) to avoid re-work and to debug prompt construction.

- [ ] Import/export with links and characters
	Ensure export archives include link metadata and character registries. On import, attempt to rewire links by `series_id` and project titles, warning on broken/missing dependencies.
	Provide a repair flow to relink manually and rehydrate caches.

### Bugs/Tech Debt
- [ ] Cycle/consistency validation for links
	Prevent self-link and cycles in series chains; enforce a single `previous_project_id`. Add integrity checks at load and repair invalid structures.
	Provide clear API errors and unit tests that cover chain creation, breaking, and relinking.

- [ ] Graceful fallback when previous project is missing
	If a linked predecessor is deleted or unavailable, narrative generation should degrade to single-project mode with a warning banner.
	Expose health in `/api/manga/{id}` and indicate broken links in the UI.

- [ ] Token budget management
	Add guardrails for prompt sizes; summarize or elide least-relevant sections first. Report final token estimates before invocation in debug logs.
	Include tests for long-running series and per-model token limits to prevent hard failures.

- [ ] Performance and caching
	Introduce memoization for context assembly and character retrieval with content-hash keys. Avoid repeated disk I/O on large series by keeping a small LRU in memory.
	Ensure atomic updates to `projects.json` with file locks to prevent partial writes under concurrent edits.

- [ ] Security and privacy boundaries
	If/when auth is added, enforce that only authorized users can link projects and read prior context. Avoid leaking characters or narration across tenants.
	Sanitize and validate character fields (e.g., prevent script injection in descriptions shown in the UI).

- [ ] Data migration and schema versioning
	Add `schema_version` and a migration on load to insert `characters` and link fields with safe defaults. Maintain a CHANGELOG entry and a one-time upgrade note.
	Provide a dry-run mode to preview changes and a backup of the original file.

- [ ] UX polish and error surfacing
	Show spinners and toasts during linking, importing characters, and context compilation. Clearly distinguish auto-imported vs. locally-edited character data.
	Add undo/redo for character edits and link changes where feasible.
