# Vim Navigation — Internals

Read-only Vim-style navigation (Normal / Visual / Cmdline), toggleable and
data-driven. User contract: [`docs/vim.md`](../vim.md). This file covers the
implementation for maintainers.

## Architecture

```
keydown (shortcuts.js, capture)
  └─ vimHandleKey(e) [vim.js] — consumes iff Vim enabled + Normal/Visual key
       ├─ motions → vimRunAction → cursor primitives (cursor.js/tabs.js)
       ├─ visual  → native Selection via vimDomPoint + selbar.js UI
       ├─ search  → /api/search → S.find → vimJump (find.js-compatible shape)
       └─ ex      → #vim-bar → vimRunEx/vimExecEx → existing commands
```

No new server endpoints. All navigation reuses existing primitives and APIs;
Vim is a frontend-only input layer (~zero binary cost beyond the bundle).

## Key handling order (`shortcuts.js`)

1. `e.target.id === 'vim-input'` → `vimHandleKey` owns Enter/Esc/Up/Down/Tab
   (plus selection-aware `C-c`), returns false for text keys so typing works
   (capture-phase safe).
2. Vim enabled + `vimHandleKey(e)` true → `preventDefault + stopPropagation`,
   existing `j/k/?/...` handlers never run.
3. Otherwise existing handling unchanged. `vimNormalizeEvent` returns null for
   Mod/Alt combos, `F12`, and non-vim Ctrl keys so `Mod+P/F/G/B/D`, `Alt+*`,
   LSP keys keep working. Ctrl-letter candidates (`C-x`) are only consumed on
   a keymap hit — misses fall through to px0/browser untouched.

Browser safety (hard rules, see `docs/vim.md`): no handling of
`C-w/t/n/Tab`; no default bindings on `C-d/u/f/b/o/i` (bookmark,
view-source, find, open-file…); `d`/`u` half-page and physical `PgUp/PgDn`
instead. `C-c` is never an Esc alias (copy wins; in-cmdline it cancels only
with a collapsed selection). `Enter`/`Space` yield when a button/link is
focused. Esc is `Esc`/`C-[` only.

`inField` (palette/find/search inputs), `#overlay`, `#helpsheet` → Vim yields.

## Text model

`d.lines` holds **highlighted HTML**, so motions read plain text via
`vimLineText(d, n)`: live row `.c` `textContent` when rendered, else
tag-stripped `d.lines[n-1]`. Missing chunks (not yet fetched) read as `''`,
so far-off word motions degrade to line stops instead of blocking on fetch.
`j/k/gg/G` never need text and always work.

`d.col` may be `Infinity` (line edge); `vimClampedCol` resolves it against the
current line length.

## Motions

- `h/l`: no line wrap (unlike `cursor.js moveCol`); `$` stops at `len-1` in
  Normal so the caret stays on text, `len` in Visual so the selection can
  include EOL.
- `w/W/b/B/e/E`: three-class scanner (blank / word / punct) for small words,
  two-class (blank / non-blank) for WORDs; multiline with blank-line skipping,
  guarded (12k iterations) and capped blank skips.
- `f/F/t/T`: in-line nth-occurrence; pending-`needChar` state holds the count;
  `;`/`,` use `vimLastFind`.
- `%`: bracket under cursor else next on line else forward scan (500 lines),
  then nesting scan (±3000 lines).
- Counts: digit buffer (`0` special-cased as motion when empty); `G`/`gg`
  with explicit count go to that line.
- Viewport (`H/M/L`, `C-d/u/f/b`, `zz/zt/zb`): `LH`-based math on `vp`;
  when `previewing()`, vertical motions scroll `#mdview` and re-anchor via
  `previewLine(d.cur)` instead of moving `vp`.

Large jumps (`gg/G`, search landings, `:n`, `gd`, symbol/blank leaps)
`pushHistory`; stepwise motions don't (history spam).

Large leaps: `]]`/`[[` (`vimSymbolJump`) reuse the regex outline via
`/api/outline` (loaded on demand like the symbol palette, cached on the tab);
`}`/`{` (`vimBlankJump`) scan `vimLineText` for whitespace-only lines with
vim paragraph semantics (skip current run, land on next blank, EOF/BOF at the
ends). Both take counts and work in Visual mode (extend selection).

## Visual mode

Anchor `{line,col,lineMode}` at entry; every motion re-runs `vimVisualUpdate`,
which sets a native `Range` from `vimDomPoint` lookups (renderer-private
`toPoint` duplicated to avoid touching `renderer.js`). Out-of-window focus
falls back to row edges. `updateSelectionBar` drives the existing footer
selection UI; `y` uses `copyToClipboard` then `vimExitVisual`; `o` flips
`vimVisualSwap`.

## Search

`vimDoSearch` mirrors `find.js runFind` request/response shaping
(`hits:[{line,n}]`, `byLine`) so `decorate()` highlighting and
`drawMinimap()` work unchanged, with `S.find.ci = !ignorecase`. Landing picks
the nearest match in `dir` (wraps). `n/N` step `S.find.active` when
highlighted, else re-run `vimLastSearch`. With `hlsearch` off, jumps still
work but `S.find` stays null (no highlight) and `n/N` re-search. `/`/`?` bar
input debounces live search (280 ms).

## Ex line (`#vim-bar`)

Bottom-anchored `absolute` bar in `#editor` (above `#status`), reusing theme
tokens only. `vimOpenBar(kind)` sets `vimModeCache='cmdline'` (restored on
close); histories capped at 50 (session-only). `vimRunEx` handles `:n`/`:a,b`
ranges first, then `name!` alias lookup (`VIM_EX_DEFAULTS` + deltas),
dispatching in `vimExecEx` to `tabs.js` (`openFile/switchTab/closeTab`),
`inspector.js`, `find.js clearFind`, palette (`openPalette`), `toggleDiff`,
theme, help (via `#btn-help` click to avoid a shortcuts cycle), and `:set`
(`wrap`/`number` delegate to renderer toggles via static import).

Errors keep the bar open with `.err` message; success closes it.

## Options & keymap persistence

- `px0.vim.enabled` (bool), `px0.vim.keys` (deltas `{normal:{lhs:action|null}}`),
  `px0.vim.opts` (JSON), histories session-only.
- `vimLoadKeymap` merges deltas over `VIM_DEFAULTS`; `vimValidateKeymap`
  toasts-and-ignores unknown actions. `:map` writes deltas live.
- `relativenumber` rewrites visible `.g` cells via `vimApplyRelativeNumbers`,
  kept correct across repaints by a `MutationObserver` on `#rows`.

## Naming & bundling constraints

`scripts/build-web.js` concatenates `web/src/` into one IIFE scope: every
top-level name in `vim.js`/`vim-keymap.js` is `vim`/`VIM`-prefixed
(`readJSON`, `LS_*` are module-local and unique — verified). Cross-module
calls happen only at runtime (all `export function` decls hoist), which is
what tolerates the `shortcuts → vim → palette → shortcuts` import cycle.

## Performance notes

Motions are O(visible text) except intentionally bounded scans (word guard,
bracket ±3000 lines, `*` one search request). No per-keystroke indexing or
full-file reads; chunk fetching stays demand-driven via `ensureChunks`.
Bundle impact ~+15 KB (2 modules, zero dependencies).
