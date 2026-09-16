// web/src/vim-keymap.js
// Default key bindings for Vim navigation mode.
//
// This file is the single source of truth for Vim defaults. To customize,
// prefer one of these (in increasing permanence):
//   1. Session only:  :map <lhs> <action>   (e.g. :map J halfDown)
//   2. This browser:  persisted automatically to localStorage (px0.vim.keys)
//   3. All users:     edit VIM_DEFAULTS below + docs/vim.md table, then `make web`.
//
// Key notation: single chars as-is ("h", "G", "$"), Ctrl as "C-d"/"C-o",
// two-key sequences joined with a space ("g g", "g d", "z z").
// Actions are ids in VIM_ACTIONS (implemented in vim.js). Unknown ids are
// ignored with a toast, never crash (see validateVimKeymap).
//
// Agent note: keep docs/vim.md in sync when you change defaults here.

export const VIM_DEFAULTS = {
  normal: {
    'h': 'left',
    'l': 'right',
    'j': 'down',
    'k': 'up',
    'ArrowLeft': 'left',
    'ArrowRight': 'right',
    'ArrowUp': 'up',
    'ArrowDown': 'down',
    'w': 'wordFwd',
    'W': 'WORDfwd',
    'b': 'wordBack',
    'B': 'WORDback',
    'e': 'wordEnd',
    'E': 'WORDend',
    '0': 'lineStart',
    '$': 'lineEnd',
    '^': 'lineFirstNonBlank',
    '_': 'lineFirstNonBlank',
    '+': 'firstNonBlankNext',
    'Enter': 'firstNonBlankNext',
    'G': 'bottom',
    'g g': 'top',
    'g d': 'definition',
    'g D': 'definition',
    'g r': 'references',
    'g h': 'calls',
    'K': 'hoverInfo',
    'f': 'findCharFwd',
    'F': 'findCharBack',
    't': 'tillCharFwd',
    'T': 'tillCharBack',
    ';': 'repeatFind',
    ',': 'repeatFindRev',
    '%': 'bracketMatch',
    '*': 'searchWordFwd',
    '#': 'searchWordBack',
    'H': 'viewTop',
    'M': 'viewMiddle',
    'L': 'viewBottom',
    'z z': 'centerCursor',
    'z t': 'cursorTop',
    'z b': 'cursorBottom',
    // NOTE (browser safety): classic C-d/C-u/C-f/C-b/C-o/C-i are deliberately
    // NOT bound by default — in a webpage they fight browser shortcuts
    // (bookmark, view-source, find, open-file…). Browser-safe equivalents:
    // d/u = half page (Vimium-style), physical PgUp/PgDn keys page natively,
    // Alt+Left/Right keeps working for jump history (we never steal Alt).
    // To opt back into C-* (e.g. app window), :map C-d halfDown — see docs/vim.md.
    'd': 'halfDown',
    'u': 'halfUp',
    'C-]': 'definition',
    'g t': 'nextTab',
    'g T': 'prevTab',
    '] b': 'nextTab',
    '[ b': 'prevTab',
    '] ]': 'nextSymbol',
    '[ [': 'prevSymbol',
    '}': 'nextBlank',
    '{': 'prevBlank',
    'v': 'visualMode',
    'V': 'visualLineMode',
    'y': 'yank',
    '/': 'searchFwd',
    '?': 'searchBack',
    'n': 'searchNext',
    'N': 'searchPrev',
    ':': 'exMode',
  },
  visual: {
    'h': 'left',
    'l': 'right',
    'j': 'down',
    'k': 'up',
    'w': 'wordFwd',
    'W': 'WORDfwd',
    'b': 'wordBack',
    'B': 'WORDback',
    'e': 'wordEnd',
    'E': 'WORDend',
    '0': 'lineStart',
    '$': 'lineEnd',
    '^': 'lineFirstNonBlank',
    'G': 'bottom',
    'g g': 'top',
    'f': 'findCharFwd',
    'F': 'findCharBack',
    't': 'tillCharFwd',
    'T': 'tillCharBack',
    ';': 'repeatFind',
    ',': 'repeatFindRev',
    '%': 'bracketMatch',
    'H': 'viewTop',
    'M': 'viewMiddle',
    'L': 'viewBottom',
    'd': 'halfDown',
    'u': 'halfUp',
    '] ]': 'nextSymbol',
    '[ [': 'prevSymbol',
    '}': 'nextBlank',
    '{': 'prevBlank',
    'v': 'normalMode',
    'V': 'visualLineMode',
    'y': 'yank',
    'o': 'swapEnds',
    '/': 'searchFwd',
    '?': 'searchBack',
    'n': 'searchNext',
    'N': 'searchPrev',
    ':': 'exMode',
  },
};

// Human-readable help for every action id. Used by :help-ish output,
// the helpsheet Vim section, and validation.
export const VIM_ACTIONS = {
  left: 'Move left',
  right: 'Move right',
  down: 'Move down',
  up: 'Move up',
  wordFwd: 'Next word (w)',
  WORDfwd: 'Next WORD (W)',
  wordBack: 'Prev word (b)',
  WORDback: 'Prev WORD (B)',
  wordEnd: 'End of word (e)',
  WORDend: 'End of WORD (E)',
  lineStart: 'Start of line (0)',
  lineEnd: 'End of line ($)',
  lineFirstNonBlank: 'First non-blank (^)',
  firstNonBlankNext: 'First non-blank of next line (+/Enter)',
  top: 'Top of file (gg)',
  bottom: 'Bottom of file (G)',
  nextSymbol: 'Next symbol (]])',
  prevSymbol: 'Prev symbol ([[)',
  nextBlank: 'Next blank line (})',
  prevBlank: 'Prev blank line ({)',
  definition: 'Go to definition (gd, C-])',
  references: 'Find references (gr)',
  calls: 'Call trail (gh)',
  hoverInfo: 'Hover info (K)',
  findCharFwd: 'Find char forward (f)',
  findCharBack: 'Find char backward (F)',
  tillCharFwd: 'Till char forward (t)',
  tillCharBack: 'Till char backward (T)',
  repeatFind: 'Repeat find (;)',
  repeatFindRev: 'Repeat find reverse (,)',
  bracketMatch: 'Matching bracket (%)',
  searchWordFwd: 'Search word forward (*)',
  searchWordBack: 'Search word backward (#)',
  viewTop: 'Top of viewport (H)',
  viewMiddle: 'Middle of viewport (M)',
  viewBottom: 'Bottom of viewport (L)',
  centerCursor: 'Center cursor (zz)',
  cursorTop: 'Cursor to top (zt)',
  cursorBottom: 'Cursor to bottom (zb)',
  halfDown: 'Half page down (d)',
  halfUp: 'Half page up (u)',
  pageDown: 'Page down (PgDn key; remappable)',
  pageUp: 'Page up (PgUp key; remappable)',
  jumpBack: 'Jump back (Alt+Left)',
  jumpFwd: 'Jump forward (Alt+Right)',
  nextTab: 'Next tab (gt)',
  prevTab: 'Prev tab (gT)',
  visualMode: 'Visual mode (v)',
  visualLineMode: 'Visual line mode (V)',
  normalMode: 'Normal mode (Esc)',
  yank: 'Yank/copy selection (y)',
  swapEnds: 'Swap visual ends (o)',
  searchFwd: 'Search forward (/)',
  searchBack: 'Search backward (?)',
  searchNext: 'Next match (n)',
  searchPrev: 'Prev match (N)',
  exMode: 'Command line (:)',
};

// Ex command aliases: :<name> -> canonical command implemented in vim.js.
// Users can add their own via VIM_EX_ALIASES deltas; see :command support.
export const VIM_EX_DEFAULTS = {
  'w': 'readonlyNoop',
  'wq': 'writeQuit',
  'x': 'writeQuit',
  'q': 'quit',
  'qa': 'quitAll',
  'q!': 'quit',
  'qa!': 'quitAll',
  'e': 'edit',
  'ex': 'edit',
  'ls': 'buffers',
  'buffers': 'buffers',
  'b': 'buffer',
  'bn': 'bnext',
  'bp': 'bprev',
  'n': 'bnext',
  'p': 'bprev',
  'o': 'symbols',
  'sym': 'symbols',
  'noh': 'nohl',
  'nohl': 'nohl',
  'nohlsearch': 'nohl',
  'set': 'set',
  'map': 'map',
  'unmap': 'unmap',
  'mapclear': 'mapclear',
  'theme': 'theme',
  'help': 'help',
  'diff': 'diff',
  'only': 'only',
  'vimtoggle': 'vimtoggle',
  'VimToggle': 'vimtoggle',
};

export const VIM_OPTIONS_DEFAULTS = {
  hlsearch: true,
  ignorecase: false,
  relativenumber: false,
};

const LS_KEYS = 'px0.vim.keys';
const LS_EX = 'px0.vim.ex';
const LS_OPTS = 'px0.vim.opts';

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

// Merged keymap: defaults + persisted user deltas. Deltas win; {action:null}
// removes a binding. Returns {normal:{...}, visual:{...}}.
export function vimLoadKeymap() {
  const deltas = readJSON(LS_KEYS);
  const out = {
    normal: { ...VIM_DEFAULTS.normal },
    visual: { ...VIM_DEFAULTS.visual },
  };
  for (const mode of ['normal', 'visual']) {
    const d = deltas[mode] || {};
    for (const [lhs, rhs] of Object.entries(d)) {
      if (rhs === null || rhs === undefined || rhs === '') delete out[mode][lhs];
      else out[mode][lhs] = rhs;
    }
  }
  return out;
}

export function vimSaveKeymapDelta(mode, lhs, actionOrNull) {
  const all = readJSON(LS_KEYS);
  if (!all[mode]) all[mode] = {};
  if (actionOrNull === null) all[mode][lhs] = null;
  else all[mode][lhs] = actionOrNull;
  try { localStorage.setItem(LS_KEYS, JSON.stringify(all)); } catch {}
}

export function vimClearKeymapDeltas() {
  try { localStorage.removeItem(LS_KEYS); } catch {}
}

export function vimLoadExAliases() {
  return { ...VIM_EX_DEFAULTS, ...readJSON(LS_EX) };
}

export function vimLoadOptions() {
  return { ...VIM_OPTIONS_DEFAULTS, ...readJSON(LS_OPTS) };
}

export function vimSaveOptions(opts) {
  try { localStorage.setItem(LS_OPTS, JSON.stringify(opts)); } catch {}
}

// Returns {ok:true} or {ok:false, problems:[...]}; caller toasts problems.
export function vimValidateKeymap(map) {
  const problems = [];
  for (const mode of ['normal', 'visual']) {
    for (const [lhs, action] of Object.entries(map[mode] || {})) {
      if (!VIM_ACTIONS[action]) problems.push(mode + ' "' + lhs + '" -> unknown action "' + action + '"');
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}
