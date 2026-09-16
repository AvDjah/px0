# Vim Navigation — Customization Contract

Toggleable Vim-style navigation for px0 (read-only subset, VsCodeVim / IdeaVim
flavor). This file is the **agent-editable contract**: change key bindings here
(via the system below) and keep the tables in sync. Implementation lives in
`web/src/vim.js` (engine) + `web/src/vim-keymap.js` (defaults).

> px0 is read-only by design. There is no Insert mode and no edit operators.
> `:w` is a no-op toast. See [Vim navigation internals](internals/vim-navigation.md).

## Toggle

| Method | How |
|---|---|
| Command palette | `Toggle Vim Navigation Mode` |
| Footer button | `Vim` (status bar, highlights when on) |
| Ex | `:set vim` / `:set novim`, `:VimToggle` |
| Persist | `localStorage px0.vim.enabled` (default OFF) |

When OFF, px0 behaves exactly as before (`j/k` still move one line, `?` opens
help, `:` does nothing globally).

## Modes

- **Normal** (`-- NORMAL --`): motions, `v/V` to Visual, `:` `/` `?` to cmdline.
- **Visual / Visual line** (`-- VISUAL --`): motions extend the native
  selection (status-bar actions actions). `y` yanks, shows Copy/Find UI.
  `o` swaps ends, `Esc`/`v` back to Normal.
- **Cmdline** (`:` `/` `?` in `#vim-bar`): `Enter` runs, `Esc`/`C-c`/`C-[`
  cancels, `Up/Down` history, `Tab` completes (`:b`/`:e` names, command names).
  `/`/`?` search incrementally as you type.

## Default keys (Normal unless noted)

Motions reuse `cursor.js moveCursor/moveCol`, `tabs.js centerLine`, and plain
line text (live rows preferred, tag-stripped HTML fallback).

| Keys | Action | Notes |
|---|---|---|
| `h l j k`, arrows | left/right/down/up | `h/l` stop at EOL (no wrap); count prefix (`5j`) |
| `w W b B e E` | word / WORD fwd, back, end | small word = `[A-Za-z0-9_]` + punct runs; `W` = whitespace-delimited |
| `0 $ ^ _ + Enter` | line start/end/first-non-blank/next-line | `$` stops one short of EOL in Normal (on text) |
| `f F t T <char>` | find/till char in line | `;` repeat, `,` reverse |
| `%` | bracket match `()[]{}` | multiline, nesting-aware |
| `]]` / `[[` | next / prev symbol (function, class…) | outline-based, centers + history; counts (`2]]`) |
| `}` / `{` | next / prev blank line (paragraph) | lands on free lines, EOF/BOF at ends; counts |
| `* #` | search word under cursor fwd/back | word search via `/api/search` |
| `gg G <n>G` | top / bottom / line n | centers + history push |
| `H M L` | viewport top/middle/bottom | |
| `zz zt zb` | center / top / bottom cursor | |
| `d u` | half page down/up (Vimium-style) | scrolls Markdown preview when previewing |
| `PgUp PgDn` (physical keys) | full page up/down | native keys, never remapped |
| `Alt+Left / Alt+Right` | jump history back/forward | browser's own history keys, always work |
| `gt gT` (`]b [b`) | next / prev tab | count supported |
| `gd gD C-]` | go to definition | LSP or regex fallback |
| `gr` | find references | right inspector |
| `gh` | call trail | right inspector |
| `K` | inspect word | references panel |
| `/ ? n N` | search fwd/back, next/prev | incremental; `:noh` clears |
| `v V y o` | visual, visual-line, yank, swap ends | `y` copies via clipboard |
| `:` | Ex command line | see below |

`g`-sequences (`gg gd gr gh gt`) and `z`-sequences (`zz zt zb`) use a pending
buffer (1.5 s timeout, shown in the mode chip).

## Browser safety (webpage rules)

px0 runs in the browser, so Vim **never hijacks browser shortcuts**:

- No `C-w C-t C-n C-Tab` handling at all (untouchable browser keys).
- No default bindings on `C-d C-u C-f C-b C-o C-i` — those are bookmark,
  view-source, find, bookmarks-bar, open-file and page-info in browsers.
  Equivalents are bound instead: `d`/`u` half page, `PgUp`/`PgDn` full page,
  `Alt+Left/Right` history (the browser's own history keys).
- `C-c` always means **copy**: it is not an Esc alias, and in the `:`/`/`/`?`
  bar it only cancels when the input has no selection.
- `Enter`/`Space` on a focused button or link keep their native behavior.
- Typing in any input (palette, find, search, cmdline) is never stolen;
  `?`/`:`/`/` only act as Vim keys when focus is in the code view.

Want the classic `C-d`/`C-u` back (e.g. a dedicated app window where you
accept overriding find/bookmarks)? One line each, at your own risk:

```
:map C-d halfDown
:map C-u halfUp
```

Whether the browser lets the page swallow a given `C-*` combo varies by
browser — if the browser menu still opens, that combo can't be taken.

## Ex commands (`:`)

| Command | Effect |
|---|---|
| `:e [file]` | fuzzy-open file (`/api/find`); no arg → file palette |
| `:ls` | list tabs/buffers in the bar |
| `:b <n\|name>` | switch tab by number (1-based) or fuzzy name |
| `:bn :bp` (`:n :p`) | next / prev tab |
| `:q` / `:qa` (`!` allowed) | close tab / close all tabs |
| `:only` | close all other tabs |
| `:o` | symbols panel |
| `:<n>` / `:<a>,<b>` | go to line (centers + history) |
| `:noh` | clear search highlight |
| `:set …` | options below; `:set` lists, `:set x?` queries, `:set x!` toggles |
| `:map/:nmap/:vmap <lhs> <action>` | remap (this browser, persisted) |
| `:unmap/:nunmap/:vunmap <lhs>` | remove a binding |
| `:mapclear` | clear all custom bindings (defaults back) |
| `:theme [name]` | set theme / theme picker |
| `:diff` | toggle git diff |
| `:help` | shortcut sheet (with Vim section when on) |
| `:VimToggle` | toggle Vim mode |
| `:w :wq :x` | **no-op**: toast `Read-only viewer` (tab kept open) |

Ranges other than line jumps, `:s`, `:g`, `:!`, splits, macros, marks and
registers are out of scope (no target in a single-pane read-only viewer).

## Options (`:set`)

| Option | Default | Effect |
|---|---|---|
| `hlsearch` | on | highlight search matches (`S.find` + minimap) |
| `ignorecase` | off | case-insensitive `/` `*` (server `case` param + highlight) |
| `relativenumber` | off | gutter shows relative numbers (current = absolute) |
| `wrap` | on | same as `toggleWordWrap` |
| `number` | on | same as `toggleLineNumbers` |
| `vim` | off | the master toggle |

Persisted as JSON in `localStorage px0.vim.opts`.

## How to customize (agents)

1. **Session `:map`** (fastest, survives reload in this browser):
   `:map J halfDown` — maps `J` in Normal+Visual to the `halfDown` action.
   `:nmap` / `:vmap` for one mode. RHS must be an **action id** from
   `VIM_ACTIONS` in `web/src/vim-keymap.js` (no recursive key-to-key maps v1).
   `:unmap J`, `:mapclear` to undo. Stored as deltas in `px0.vim.keys`.
2. **All users (defaults)**: edit `VIM_DEFAULTS` in `web/src/vim-keymap.js`,
   update the tables in this file, run `make web` (`node
   scripts/build-web.js`), verify `go test ./...`.
3. **Ex aliases**: `VIM_EX_DEFAULTS` in the same file (`:command` support is
   alias-level v1, not full user commands).
4. **`<C-x>` notation**: `:map <C-d> halfDown` also accepted; stored as `C-d`.

Validation: unknown action ids are ignored with a toast
(`vimValidateKeymap`), never a crash. `:map` with no args lists Normal
bindings (full table in console).

## Files

- `web/src/vim.js` — engine (dispatch, motions, visual, search, Ex, bar UI).
  All top-level names are `vim`-prefixed (bundler single-scope rule).
- `web/src/vim-keymap.js` — `VIM_DEFAULTS`, `VIM_ACTIONS`, `VIM_EX_DEFAULTS`,
  options + localStorage delta layer.
- `web/index.html` — `#vim-bar` (in `#editor`), `#vim-mode` (in `#status`),
  footer `[data-action="vim"]`.
- `web/style.css` — `#vim-bar`, `#vim-mode`, Normal block caret.
- Wiring: `shortcuts.js` (Vim-first keydown + footer button + help section),
  `palette.js` (toggle/reset commands), `main.js` (`initVim()`).
- Deep doc: `docs/internals/vim-navigation.md`.

## Test checklist

- Toggle on/off persists across reload; OFF = old behavior byte-for-byte.
- `:` opens bottom bar; `Esc` cancels; `:<n>` jumps; `:e ხ` fuzzy-opens.
- `5j gg G HML zz d/u`, `wbe/*#%f;`, `/foo` live + `n/N`, `:noh`.
- Browser keys untouched: `C-f` still finds (app find), `C-c` copies a visual
  selection, `Enter` on a focused button still clicks it.
- `v w w y` copies + status-bar selection UI; `V y` copies lines.
- `gd gr gh K`, `gt C-o`, `:b :bn :q :only`, `:set relativenumber?`.
- `:map J halfDown` → `J` half-pages; reload keeps it; `:mapclear` resets.
- `make web && go test ./... && go build -o /tmp/px0 .`
