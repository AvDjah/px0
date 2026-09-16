// web/src/vim.js
// Toggleable Vim navigation mode (read-only subset, VsCodeVim/IdeaVim-style).
//
// Scope: Normal + Visual (+Visual-line) + : Ex cmdline + / ? search.
// No Insert and no edit operators: px0 is read-only by design (see
// docs/agents/README.md). :w is a no-op toast.
//
// Customization contract: defaults live in vim-keymap.js + docs/vim.md.
// Simple remaps never touch this file: :map, localStorage deltas, or editing
// VIM_DEFAULTS. Action ids are validated against VIM_ACTIONS.
//
// Top-level names here are all vim-prefixed: scripts/build-web.js concatenates
// modules into one scope and fails the build on collisions.
import { $, S, doc_, api, LH } from './state.js';
import { vp, rowsEl, showToast, copyToClipboard } from './ui.js';
import { render, paint, rowFor, placeCaret, toggleWordWrap, toggleLineNumbers } from './renderer.js';
import { openFile, centerLine, closeTab, switchTab } from './tabs.js';
import { updateStatus } from './status.js';
import { pushHistory, go } from './history.js';
import { gotoDefinition, findReferences } from './lsp.js';
import { inspectReferences, showRightInspector } from './inspector.js';
import { showCalls } from './calls.js';
import { toggleDiff } from './diff.js';
import { previewing, previewLine } from './markdown.js';
import { openPalette } from './palette.js';
import { clearFind, drawMinimap } from './find.js';
import { updateSelectionBar, hideSelectionBar } from './selbar.js';
import { setTheme, listThemes } from './theme.js';
import { VIM_ACTIONS, vimLoadKeymap, vimSaveKeymapDelta, vimClearKeymapDeltas, vimLoadExAliases, vimLoadOptions, vimSaveOptions, vimValidateKeymap } from './vim-keymap.js';

/* ---------------- state ---------------- */

const vimLS_ENABLE = 'px0.vim.enabled';
let vimEnabled = false;
let vimModeCache = 'normal'; // normal | visual | visual-line | cmdline
let vimCountBuf = '';
let vimPending = null; // null | {prefix:'g'|'z'|'['|']',count} | {needChar:'f'|'F'|'t'|'T',count}
let vimPendingTimer = 0;
let vimKeymapCache = null;
let vimExAliasesCache = null;
let vimOptionsCache = null;
let vimVisualAnchor = null; // {line,col,lineMode} or null
let vimVisualSwap = false;
let vimLastFind = null; // {ch,kind:'f'|'F'|'t'|'T'}
let vimLastSearch = null; // {q,dir:1|-1}
let vimBarKind = null; // null | 'ex' | 'searchFwd' | 'searchBack'
let vimExHistory = [];
let vimExHistIdx = -1;
let vimSearchHistory = [];
let vimSearchHistIdx = -1;
let vimSearchTimer = 0;
let vimRelObserver = null;

function vimKeymap() {
  if (!vimKeymapCache) {
    vimKeymapCache = vimLoadKeymap();
    const v = vimValidateKeymap(vimKeymapCache);
    if (!v.ok) showToast('Vim', 'Ignoring bad bindings: ' + v.problems.slice(0, 2).join('; '));
  }
  return vimKeymapCache;
}

function vimExAliases() {
  if (!vimExAliasesCache) vimExAliasesCache = vimLoadExAliases();
  return vimExAliasesCache;
}

function vimOptions() {
  if (!vimOptionsCache) vimOptionsCache = vimLoadOptions();
  return vimOptionsCache;
}

export function vimIsEnabled() { return vimEnabled; }
export function vimMode() { return vimModeCache; }

/* ---------------- enable / disable ---------------- */

function vimReadEnabledPref() {
  try { return localStorage.getItem(vimLS_ENABLE) === 'true'; } catch { return false; }
}

function vimWriteEnabledPref() {
  try { localStorage.setItem(vimLS_ENABLE, vimEnabled ? 'true' : 'false'); } catch {}
}

export function setVimEnabled(on) {
  vimEnabled = !!on;
  vimWriteEnabledPref();
  document.body.classList.toggle('vim-on', vimEnabled);
  if (!vimEnabled) {
    vimExitVisual(true);
    vimCloseBar();
    vimPending = null;
    vimCountBuf = '';
    vimModeCache = 'normal';
  } else {
    vimModeCache = 'normal';
  }
  vimUpdateChrome();
  render();
  showToast('Vim', vimEnabled ? 'Vim navigation on (:help for keys)' : 'Vim navigation off');
}

export function toggleVim() { setVimEnabled(!vimEnabled); }

function vimUpdateChrome() {
  const chip = $('#vim-mode');
  if (chip) {
    chip.hidden = !vimEnabled;
    let label = '-- NORMAL --';
    if (vimModeCache === 'visual') label = '-- VISUAL --';
    else if (vimModeCache === 'visual-line') label = '-- VISUAL LINE --';
    else if (vimModeCache === 'cmdline') {
      label = vimBarKind === 'ex' ? ':' : vimBarKind === 'searchBack' ? '?' : '/';
    }
    if (vimPending) {
      const p = vimPending.prefix || vimPending.needChar || '';
      label += ' ' + p;
    } else if (vimCountBuf) {
      label += ' ' + vimCountBuf;
    }
    chip.textContent = label;
    chip.dataset.mode = vimModeCache;
  }
  const btn = document.querySelector('[data-action="vim"]');
  if (btn) btn.classList.toggle('active', vimEnabled);
  document.body.classList.toggle('vim-visual', vimEnabled && (vimModeCache === 'visual' || vimModeCache === 'visual-line'));
}

/* ---------------- text helpers (HTML-safe) ---------------- */
// d.lines holds highlighted HTML; the live rows hold plain text. Prefer rows,
// fall back to tag-stripped HTML so far-off lines still work for motions.
function vimLineText(d, n) {
  if (!d || n < 1 || n > d.total) return '';
  const row = rowFor(n);
  if (row) {
    const c = row.querySelector('.c');
    if (c) return c.textContent;
  }
  const raw = d.lines && d.lines[n - 1];
  if (typeof raw !== 'string') return '';
  return raw.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function vimLineLen(d, n) { return vimLineText(d, n).length; }

function vimClampedCol(d, len) {
  const c = d.col;
  if (c === Infinity) return len;
  return Math.max(0, Math.min(c || 0, len));
}

function vimWordUnderCursor(d) {
  const t = vimLineText(d, d.cur);
  if (!t) return null;
  const col = vimClampedCol(d, t.length);
  const isW = ch => /[A-Za-z0-9_]/.test(ch);
  let a = Math.min(col, t.length), b = a;
  if (a < t.length && isW(t[a])) {
    while (a > 0 && isW(t[a - 1])) a--;
    while (b < t.length && isW(t[b])) b++;
    return { word: t.slice(a, b), col: a };
  }
  // On punctuation: take the punctuation run (vim small-word behavior).
  if (a < t.length && !/\s/.test(t[a])) {
    while (a > 0 && !/\s/.test(t[a - 1]) && !isW(t[a - 1])) a--;
    while (b < t.length && !/\s/.test(t[b]) && !isW(t[b])) b++;
    return { word: t.slice(a, b), col: a };
  }
  return null;
}

/* ---------------- cursor primitives ---------------- */

function vimEnsureVisible(d, center) {
  if (previewing()) { try { previewLine(d.cur); } catch {} }
  else if (center === true) centerLine(d.cur);
  else {
    const y = (d.cur - 1) * LH;
    if (y < vp.scrollTop) vp.scrollTop = y - LH;
    else if (y > vp.scrollTop + vp.clientHeight - LH * 2) vp.scrollTop = y - vp.clientHeight + LH * 3;
  }
  render();
  updateStatus();
  if (vimOptions().relativenumber) vimApplyRelativeNumbers();
}

function vimMoveTo(d, line, col, opts = {}) {
  d.cur = Math.max(1, Math.min(d.total, line));
  const len = vimLineLen(d, d.cur);
  d.col = Math.max(0, Math.min(col, len));
  vimEnsureVisible(d, opts.center);
  if (opts.push) pushHistory(d.path, d.cur);
  if (vimModeCache === 'visual' || vimModeCache === 'visual-line') vimVisualUpdate();
  else placeCaret();
}

function vimScrollPreviewBy(px) {
  const md = $('#mdview');
  if (md && previewing()) md.scrollBy({ top: px });
}

/* ---------------- word motions ---------------- */

function vimCharClass(ch, big) {
  if (ch === ' ' || ch === '\t') return 0;
  if (big) return 1;
  if (/[A-Za-z0-9_]/.test(ch)) return 1;
  return 2;
}

// Forward to start of next word/WORD (w/W). Returns {line,col} or null at EOF.
function vimFindWordFwd(d, line, col, big, count) {
  let L = line, C = col;
  for (let k = 0; k < count; k++) {
    let t = vimLineText(d, L);
    // If inside a word, first skip to its end.
    if (C < t.length && vimCharClass(t[C], big) !== 0) {
      const cls = vimCharClass(t[C], big);
      while (C < t.length && vimCharClass(t[C], big) === cls) C++;
    }
    let found = false;
    let guard = 0;
    while (guard++ < 12000) {
      t = vimLineText(d, L);
      // Skip whitespace/punctuation gap to next word start on this line.
      while (C < t.length && vimCharClass(t[C], big) === 0) C++;
      if (C < t.length) {
        if (big) { found = true; break; }
        // Small word: land on word or punct start (skip nothing: C is at one).
        found = true;
        break;
      }
      if (L >= d.total) break;
      L++; C = 0;
      // Skip blank lines.
      let skip = 0;
      while (L <= d.total && vimLineText(d, L) === '' && skip++ < 500) L++;
      if (L > d.total) break;
      t = vimLineText(d, L);
      while (C < t.length && vimCharClass(t[C], big) === 0) C++;
      if (C < t.length) { found = true; break; }
      // Line of only whitespace: continue to next line on next iteration.
      if (C >= t.length) { if (L >= d.total) break; L++; C = 0; continue; }
    }
    if (!found) return k === 0 ? null : { line: L, col: C };
    // For small words starting mid-gap of punct vs word: C already at start. Done.
  }
  return { line: L, col: C };
}

function vimFindWordEnd(d, line, col, big, count) {
  let L = line, C = col;
  for (let k = 0; k < count; k++) {
    let advanced = false;
    let guard = 0;
    while (guard++ < 12000) {
      const t = vimLineText(d, L);
      if (!advanced) {
        // Step one char forward first (e moves past current char).
        if (C + 1 < t.length) { C++; advanced = true; }
        else if (L < d.total) { L++; C = 0; advanced = true; let s = 0; while (L <= d.total && vimLineText(d, L) === '' && s++ < 500) L++; if (L > d.total) return k === 0 ? null : { line: L - 1, col: vimLineLen(d, L - 1) }; continue; }
        else return k === 0 ? null : { line: L, col: C };
        continue;
      }
      const t2 = vimLineText(d, L);
      while (C < t2.length && vimCharClass(t2[C], big) === 0) {
        C++;
        if (C >= t2.length) break;
      }
      if (C >= t2.length) {
        if (L >= d.total) return { line: L, col: Math.max(0, t2.length - 1) };
        L++; C = 0; advanced = true;
        let s = 0;
        while (L <= d.total && vimLineText(d, L) === '' && s++ < 500) L++;
        if (L > d.total) return { line: L - 1, col: 0 };
        continue;
      }
      const cls = vimCharClass(t2[C], big);
      while (C + 1 < t2.length && vimCharClass(t2[C + 1], big) === cls) C++;
      break;
    }
  }
  return { line: L, col: C };
}

function vimFindWordBack(d, line, col, big, count) {
  let L = line, C = col;
  for (let k = 0; k < count; k++) {
    let guard = 0;
    let moved = false;
    // Step one char back first so repeated b keeps moving.
    if (C > 0) { C--; moved = true; }
    else if (L > 1) { L--; C = Math.max(0, vimLineLen(d, L) - 1); if (vimLineText(d, L) === '') { // blank line is a stop
        return { line: L, col: 0 };
      } moved = true; }
    else return k === 0 ? null : { line: L, col: C };
    while (guard++ < 12000) {
      const t = vimLineText(d, L);
      while (C > 0 && vimCharClass(t[C] ?? ' ', big) === 0) C--;
      if (vimCharClass(t[C] ?? ' ', big) === 0) {
        if (L <= 1) return { line: 1, col: 0 };
        L--; C = Math.max(0, vimLineLen(d, L) - 1);
        if (vimLineText(d, L) === '') return { line: L, col: 0 };
        continue;
      }
      const cls = vimCharClass(t[C], big);
      while (C > 0 && vimCharClass(t[C - 1], big) === cls) C--;
      break;
    }
    void moved;
  }
  return { line: L, col: C };
}

function vimFirstNonBlank(d, n) {
  const t = vimLineText(d, n);
  const m = /^[ \t]*/.exec(t);
  return m ? m[0].length : 0;
}

/* ---------------- char find f/F/t/T ---------------- */

function vimCharFind(d, ch, kind, count) {
  const t = vimLineText(d, d.cur);
  const col = vimClampedCol(d, t.length);
  let c = col;
  for (let k = 0; k < count; k++) {
    let idx = -1;
    if (kind === 'f') idx = t.indexOf(ch, c + 1);
    else if (kind === 't') { idx = t.indexOf(ch, c + 1); if (idx > 0) idx--; }
    else if (kind === 'F') idx = t.lastIndexOf(ch, c - 1);
    else if (kind === 'T') { idx = t.lastIndexOf(ch, c - 1); if (idx >= 0 && idx + 1 < t.length) idx++; }
    if (idx < 0) return k === 0 ? null : { line: d.cur, col: c };
    c = idx;
  }
  return { line: d.cur, col: c };
}

/* ---------------- bracket match ---------------- */

function vimBracketMatch(d) {
  const pairs = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
  const opens = new Set(['(', '[', '{']);
  let t = vimLineText(d, d.cur);
  let col = vimClampedCol(d, t.length);
  let startLine = d.cur, startCol = -1, dir = 0, open = '', close = '';
  if (col < t.length && pairs[t[col]]) {
    startCol = col;
  } else {
    const idx = t.slice(col).search(/[()[\]{}]/);
    if (idx >= 0) startCol = col + idx;
  }
  if (startCol >= 0) {
    const b = t[startCol];
    if (opens.has(b)) { dir = 1; open = b; close = pairs[b]; }
    else { dir = -1; close = b; open = pairs[b]; }
  } else {
    // Scan forward for the next bracket (up to 500 lines).
    for (let L = startLine + 1; L <= Math.min(d.total, startLine + 500); L++) {
      const tt = vimLineText(d, L);
      const m = /[()[\]{}]/.exec(tt);
      if (m) {
        startLine = L; startCol = m.index;
        const b = tt[startCol];
        if (opens.has(b)) { dir = 1; open = b; close = pairs[b]; }
        else { dir = -1; close = b; open = pairs[b]; }
        break;
      }
    }
    if (startCol < 0) { showToast('!', 'No bracket found'); return; }
  }
  let depth = dir === 1 ? 1 : 1;
  if (dir === 1) {
    let tt = vimLineText(d, startLine);
    for (let L = startLine; L <= Math.min(d.total, startLine + 3000); L++) {
      tt = vimLineText(d, L);
      const from = L === startLine ? startCol + 1 : 0;
      for (let i = from; i < tt.length; i++) {
        if (tt[i] === open) depth++;
        else if (tt[i] === close) { depth--; if (depth === 0) { vimMoveTo(d, L, i, { push: true }); return; } }
      }
    }
  } else {
    for (let L = startLine; L >= Math.max(1, startLine - 3000); L--) {
      const tt = vimLineText(d, L);
      const to = L === startLine ? startCol - 1 : tt.length - 1;
      for (let i = to; i >= 0; i--) {
        if (tt[i] === close) depth++;
        else if (tt[i] === open) { depth--; if (depth === 0) { vimMoveTo(d, L, i, { push: true }); return; } }
      }
    }
  }
  showToast('!', 'No matching bracket');
}

/* ---------------- large leaps: symbols + blank lines ---------------- */

// Next/prev symbol (]]) — jumps between outline entries (functions, classes…).
// Loads the regex outline on demand like the symbol palette does.
async function vimSymbolJump(d, dir, count) {
  if (!d.outline) {
    try { d.outline = (await api('/api/outline', { path: d.path })).symbols || []; }
    catch { d.outline = []; }
  }
  const lines = [...new Set((d.outline || []).map(s => s.line))].sort((a, b) => a - b);
  if (!lines.length) { showToast('!', 'No symbols in this file'); return; }
  let target = -1;
  if (dir > 0) {
    const ahead = lines.filter(l => l > d.cur);
    if (!ahead.length) { showToast('!', 'No next symbol'); return; }
    target = ahead[Math.min(count - 1, ahead.length - 1)];
  } else {
    const behind = lines.filter(l => l < d.cur);
    if (!behind.length) { showToast('!', 'No previous symbol'); return; }
    target = behind[Math.max(0, behind.length - count)];
  }
  vimMoveTo(d, target, vimFirstNonBlank(d, target), { center: true, push: true });
}

// Next/prev blank line (}/}) — vim paragraph motions over free lines.
function vimBlankJump(d, dir, count) {
  const isBlank = n => vimLineText(d, n).trim() === '';
  let L = d.cur;
  for (let k = 0; k < count; k++) {
    if (dir > 0) {
      let n = L;
      while (n <= d.total && isBlank(n)) n++; // skip current blank run
      while (n <= d.total && !isBlank(n)) n++; // advance to next blank
      L = Math.min(n, d.total); // EOF when no blank ahead (vim {}/} behavior)
    } else {
      let n = L;
      while (n >= 1 && isBlank(n)) n--;
      while (n >= 1 && !isBlank(n)) n--;
      L = Math.max(n, 1); // BOF when no blank behind
    }
  }
  vimMoveTo(d, L, 0, { center: false, push: true });
}

/* ---------------- viewport motions ---------------- */

function vimViewportLines() {
  return Math.max(1, Math.floor(vp.clientHeight / LH));
}

function vimFirstVisibleLine() {
  return Math.max(1, Math.floor(vp.scrollTop / LH) + 1);
}

/* ---------------- visual mode ---------------- */

function vimEnterVisual(lineMode) {
  const d = doc_();
  if (!d) return;
  vimModeCache = lineMode ? 'visual-line' : 'visual';
  vimVisualAnchor = { line: d.cur, col: lineMode ? 0 : vimClampedCol(d, vimLineLen(d, d.cur)), lineMode };
  vimVisualSwap = false;
  vimUpdateChrome();
  vimVisualUpdate();
  showToast('', lineMode ? 'Visual line' : 'Visual');
}

export function vimExitVisual(silent) {
  if (vimModeCache !== 'visual' && vimModeCache !== 'visual-line') return;
  vimModeCache = 'normal';
  vimVisualAnchor = null;
  vimVisualSwap = false;
  try { window.getSelection()?.removeAllRanges(); } catch {}
  hideSelectionBar();
  if (!silent) { vimUpdateChrome(); placeCaret(); }
  else vimUpdateChrome();
}

// DOM point for (line,col) without depending on renderer's private toPoint.
function vimDomPoint(line, col) {
  const row = rowFor(line);
  if (!row) return null;
  const code = row.querySelector('.c');
  if (!code) return null;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue.length;
    if (col <= at + len) return [n, col - at];
    at += len;
  }
  return [code, code.childNodes.length];
}

function vimVisualUpdate() {
  const d = doc_();
  if (!d || !vimVisualAnchor) return;
  let aLine = vimVisualAnchor.line, aCol = vimVisualAnchor.col;
  let fLine = d.cur, fCol = vimModeCache === 'visual-line' ? vimLineLen(d, d.cur) : vimClampedCol(d, vimLineLen(d, d.cur));
  if (vimModeCache === 'visual-line') aCol = 0;
  if (vimVisualSwap) { const tl = aLine; aLine = fLine; fLine = tl; const tc = aCol; aCol = fCol; fCol = tc; }
  // Order anchor->focus for the selection direction.
  const fwd = fLine > aLine || (fLine === aLine && fCol >= aCol);
  const from = fwd ? { line: aLine, col: aCol } : { line: fLine, col: fCol };
  const to = fwd ? { line: fLine, col: vimModeCache === 'visual-line' ? fCol + 1 : fCol + 1 } : { line: aLine, col: vimModeCache === 'visual-line' ? aCol + 1 : aCol + 1 };
  const pa = vimDomPoint(from.line, from.col);
  let pf = vimDomPoint(to.line, Math.max(0, to.col));
  if (!pa) return;
  if (!pf) {
    // Focus scrolled out of the windowed rows: fall back to row edges.
    const row = rowFor(to.line);
    if (!row) { placeCaret(); return; }
    const code = row.querySelector('.c');
    pf = [code, code.childNodes.length];
  }
  try {
    const sel = window.getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(pa[0], pa[1]);
    r.setEnd(pf[0], pf[1]);
    sel.addRange(r);
  } catch {}
  setTimeout(updateSelectionBar, 20);
  placeCaret();
}

function vimYank() {
  const d = doc_();
  if (!d) return;
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  if (text) {
    copyToClipboard(text, 'Yanked ' + text.length.toLocaleString() + ' chars');
  } else {
    // No native selection (focus line out of window): copy current line text.
    const t = vimLineText(d, d.cur);
    if (t) copyToClipboard(t, 'Yanked line ' + d.cur);
    else showToast('!', 'Nothing to yank');
  }
  vimExitVisual();
}

/* ---------------- search ---------------- */

async function vimDoSearch(pattern, dir, opts = {}) {
  const d = doc_();
  if (!d || !pattern) return false;
  let j;
  try {
    j = await api('/api/search', {
      q: pattern,
      glob: d.path,
      case: vimOptions().ignorecase ? '' : 1,
    });
  } catch (e) { vimBarMsg('Search error: ' + e.message, true); return false; }
  const f = (j.results || []).find(r => r.path === d.path);
  const hits = [];
  if (f) {
    let prevLine = -1, n = 0;
    for (const m of f.matches) {
      n = m.line === prevLine ? n + 1 : 0;
      prevLine = m.line;
      hits.push({ line: m.line, n });
    }
  }
  if (!hits.length) {
    if (!opts.live) vimBarMsg('No matches for "' + pattern + '"', true);
    S.find = null;
    paint();
    return false;
  }
  vimLastSearch = { q: pattern, dir };
  if (vimOptions().hlsearch) {
    S.find = { q: pattern, ci: !vimOptions().ignorecase, hits, byLine: new Set(hits.map(h => h.line)), active: 0 };
    drawMinimap(hits, d.total);
  } else {
    S.find = null;
  }
  // Initial landing: nearest match in the search direction (wrap).
  let idx = 0;
  if (dir >= 0) {
    idx = hits.findIndex(h => h.line > d.cur);
    if (idx < 0) idx = 0;
  } else {
    idx = -1;
    for (let i = hits.length - 1; i >= 0; i--) { if (hits[i].line < d.cur) { idx = i; break; } }
    if (idx < 0) idx = hits.length - 1;
  }
  if (vimOptions().hlsearch) S.find.active = idx;
  const h = hits[idx];
  vimMoveTo(d, h.line, d.col, { push: !opts.live });
  if (vimOptions().hlsearch) S.find.active = idx;
  vimBarMsg((idx + 1) + ' / ' + hits.length);
  return true;
}

function vimSearchStep(delta) {
  const d = doc_();
  if (!d) return;
  if (S.find && S.find.hits && S.find.hits.length && vimOptions().hlsearch) {
    const n = S.find.hits.length;
    const next = ((S.find.active + delta) % n + n) % n;
    S.find.active = next;
    const h = S.find.hits[next];
    vimMoveTo(d, h.line, d.col, {});
    vimBarMsg((next + 1) + ' / ' + n);
    return;
  }
  if (vimLastSearch) {
    vimDoSearch(vimLastSearch.q, delta >= 0 ? 1 : -1, {});
    return;
  }
  showToast('!', 'No search yet (use / or ?)');
}

function vimSearchWord(dir) {
  const d = doc_();
  if (!d) return;
  const w = vimWordUnderCursor(d);
  if (!w || !w.word) { showToast('!', 'No word under cursor'); return; }
  S.lastWord = w.word;
  vimWordSearch(w.word, dir);
}

async function vimWordSearch(word, dir) {
  const d = doc_();
  if (!d) return;
  let j;
  try {
    j = await api('/api/search', { q: word, glob: d.path, word: 1, case: vimOptions().ignorecase ? '' : 1 });
  } catch (e) { showToast('!', e.message); return; }
  const f = (j.results || []).find(r => r.path === d.path);
  const hits = [];
  if (f) {
    let prevLine = -1, n = 0;
    for (const m of f.matches) {
      n = m.line === prevLine ? n + 1 : 0;
      prevLine = m.line;
      hits.push({ line: m.line, n });
    }
  }
  if (!hits.length) { showToast('!', 'No matches for "' + word + '"'); return; }
  vimLastSearch = { q: word, dir };
  if (vimOptions().hlsearch) {
    S.find = { q: word, ci: !vimOptions().ignorecase, hits, byLine: new Set(hits.map(h => h.line)), active: 0 };
    drawMinimap(hits, d.total);
  }
  let idx = dir >= 0 ? hits.findIndex(h => h.line > d.cur) : -1;
  if (dir >= 0 && idx < 0) idx = 0;
  if (dir < 0) {
    idx = -1;
    for (let i = hits.length - 1; i >= 0; i--) { if (hits[i].line < d.cur) { idx = i; break; } }
    if (idx < 0) idx = hits.length - 1;
  }
  if (vimOptions().hlsearch) S.find.active = idx;
  vimMoveTo(d, hits[idx].line, d.col, { push: true });
  if (vimOptions().hlsearch) S.find.active = idx;
}

/* ---------------- actions ---------------- */

function vimIsVisual() { return vimModeCache === 'visual' || vimModeCache === 'visual-line'; }

function vimActLeft(d, count) {
  if (previewing()) { vimScrollPreviewBy(0); return; }
  const len = vimLineLen(d, d.cur);
  vimMoveTo(d, d.cur, vimClampedCol(d, len) - count, {});
}
function vimActRight(d, count) {
  if (previewing()) return;
  const len = vimLineLen(d, d.cur);
  // Vim normal mode stops one short of EOL; keep the caret on text.
  const max = Math.max(0, len - (vimIsVisual() ? 0 : 1));
  vimMoveTo(d, d.cur, Math.min(vimClampedCol(d, len) + count, max), {});
}
function vimActDown(d, count) {
  if (previewing()) { vimScrollPreviewBy(48 * count); d.cur = Math.min(d.total, d.cur + count); try { previewLine(d.cur); } catch {} updateStatus(); return; }
  vimMoveTo(d, d.cur + count, d.col === Infinity ? Infinity : (d.col || 0), {});
}
function vimActUp(d, count) {
  if (previewing()) { vimScrollPreviewBy(-48 * count); d.cur = Math.max(1, d.cur - count); try { previewLine(d.cur); } catch {} updateStatus(); return; }
  vimMoveTo(d, d.cur - count, d.col === Infinity ? Infinity : (d.col || 0), {});
}

function vimRunAction(action, count, extra) {
  const d = doc_();
  if (!d) return;
  count = Math.max(1, count || 1);
  switch (action) {
    case 'left': for (let i = 0; i < count; i++) vimActLeft(d, 1); break;
    case 'right': for (let i = 0; i < count; i++) vimActRight(d, 1); break;
    case 'down': vimActDown(d, count); break;
    case 'up': vimActUp(d, count); break;
    case 'wordFwd': { const r = vimFindWordFwd(d, d.cur, vimClampedCol(d, vimLineLen(d, d.cur)), false, count); if (r) vimMoveTo(d, r.line, r.col, {}); break; }
    case 'WORDfwd': { const r = vimFindWordFwd(d, d.cur, vimClampedCol(d, vimLineLen(d, d.cur)), true, count); if (r) vimMoveTo(d, r.line, r.col, {}); break; }
    case 'wordBack': { const r = vimFindWordBack(d, d.cur, vimClampedCol(d, vimLineLen(d, d.cur)), false, count); if (r) vimMoveTo(d, r.line, r.col, {}); break; }
    case 'WORDback': { const r = vimFindWordBack(d, d.cur, vimClampedCol(d, vimLineLen(d, d.cur)), true, count); if (r) vimMoveTo(d, r.line, r.col, {}); break; }
    case 'wordEnd': { const r = vimFindWordEnd(d, d.cur, vimClampedCol(d, vimLineLen(d, d.cur)), false, count); if (r) vimMoveTo(d, r.line, r.col, {}); break; }
    case 'WORDend': { const r = vimFindWordEnd(d, d.cur, vimClampedCol(d, vimLineLen(d, d.cur)), true, count); if (r) vimMoveTo(d, r.line, r.col, {}); break; }
    case 'lineStart': vimMoveTo(d, d.cur, 0, {}); break;
    case 'lineEnd': vimMoveTo(d, d.cur, Math.max(0, vimLineLen(d, d.cur) - (vimIsVisual() ? 0 : 1)), {}); break;
    case 'lineFirstNonBlank': vimMoveTo(d, d.cur, vimFirstNonBlank(d, d.cur), {}); break;
    case 'firstNonBlankNext': { const n = Math.min(d.total, d.cur + count); vimMoveTo(d, n, vimFirstNonBlank(d, n), {}); break; }
    case 'top': {
      const n = (extra && extra.explicitCount) ? Math.min(d.total, count) : 1;
      vimMoveTo(d, n, vimFirstNonBlank(d, n), { center: true, push: true });
      break;
    }
    case 'bottom': {
      const n = (extra && extra.explicitCount) ? Math.min(d.total, count) : d.total;
      vimMoveTo(d, n, vimFirstNonBlank(d, n), { center: true, push: true });
      break;
    }
    case 'definition': {
      const w = vimWordUnderCursor(d);
      pushHistory(d.path, d.cur);
      gotoDefinition(w ? { word: w.word, line: d.cur, col: w.col, path: d.path } : undefined);
      break;
    }
    case 'references': {
      const w = vimWordUnderCursor(d);
      if (w) findReferences({ word: w.word, line: d.cur, col: w.col, path: d.path });
      else findReferences();
      break;
    }
    case 'calls': showCalls(); break;
    case 'hoverInfo': {
      const w = vimWordUnderCursor(d);
      if (w) inspectReferences({ word: w.word, line: d.cur, col: w.col, path: d.path });
      else showToast('!', 'No identifier under cursor');
      break;
    }
    case 'findCharFwd':
    case 'findCharBack':
    case 'tillCharFwd':
    case 'tillCharBack': {
      if (extra && extra.ch) {
        const kind = { findCharFwd: 'f', findCharBack: 'F', tillCharFwd: 't', tillCharBack: 'T' }[action];
        const r = vimCharFind(d, extra.ch, kind, count);
        if (r) { vimMoveTo(d, r.line, r.col, {}); vimLastFind = { ch: extra.ch, kind }; }
        else showToast('!', 'Char not found: ' + extra.ch);
      } else {
        vimPending = { needChar: action, count };
        vimUpdateChrome();
      }
      break;
    }
    case 'repeatFind': {
      if (!vimLastFind) { showToast('!', 'No find yet (f/F/t/T first)'); break; }
      const r = vimCharFind(d, vimLastFind.ch, vimLastFind.kind, count);
      if (r) vimMoveTo(d, r.line, r.col, {});
      break;
    }
    case 'repeatFindRev': {
      if (!vimLastFind) { showToast('!', 'No find yet (f/F/t/T first)'); break; }
      const rev = { f: 'F', F: 'f', t: 'T', T: 't' }[vimLastFind.kind];
      const r = vimCharFind(d, vimLastFind.ch, rev, count);
      if (r) vimMoveTo(d, r.line, r.col, {});
      break;
    }
    case 'bracketMatch': vimBracketMatch(d); break;
    case 'nextSymbol': vimSymbolJump(d, 1, count); break;
    case 'prevSymbol': vimSymbolJump(d, -1, count); break;
    case 'nextBlank': vimBlankJump(d, 1, count); break;
    case 'prevBlank': vimBlankJump(d, -1, count); break;
    case 'searchWordFwd': vimSearchWord(1); break;
    case 'searchWordBack': vimSearchWord(-1); break;
    case 'viewTop': { const n = vimFirstVisibleLine(); vimMoveTo(d, n, vimFirstNonBlank(d, n), {}); break; }
    case 'viewMiddle': { const n = Math.min(d.total, vimFirstVisibleLine() + Math.floor(vimViewportLines() / 2)); vimMoveTo(d, n, vimFirstNonBlank(d, n), {}); break; }
    case 'viewBottom': { const n = Math.min(d.total, vimFirstVisibleLine() + vimViewportLines() - 1); vimMoveTo(d, n, vimFirstNonBlank(d, n), {}); break; }
    case 'centerCursor': vimEnsureVisible(d, true); break;
    case 'cursorTop': { vp.scrollTop = Math.max(0, (d.cur - 1) * LH); render(); if (vimOptions().relativenumber) vimApplyRelativeNumbers(); break; }
    case 'cursorBottom': { vp.scrollTop = Math.max(0, (d.cur - 1) * LH - vp.clientHeight + LH * 2); render(); if (vimOptions().relativenumber) vimApplyRelativeNumbers(); break; }
    case 'halfDown': {
      if (previewing()) { vimScrollPreviewBy(vp.clientHeight / 2); break; }
      const by = Math.max(1, Math.floor(vimViewportLines() / 2));
      vp.scrollTop += by * LH;
      vimMoveTo(d, d.cur + by * count, d.col || 0, {});
      break;
    }
    case 'halfUp': {
      if (previewing()) { vimScrollPreviewBy(-vp.clientHeight / 2); break; }
      const by = Math.max(1, Math.floor(vimViewportLines() / 2));
      vp.scrollTop -= by * LH;
      vimMoveTo(d, d.cur - by * count, d.col || 0, {});
      break;
    }
    case 'pageDown': {
      if (previewing()) { vimScrollPreviewBy(vp.clientHeight * 0.9); break; }
      const by = Math.max(1, vimViewportLines() - 1);
      vp.scrollTop += by * LH;
      vimMoveTo(d, d.cur + by * count, d.col || 0, {});
      break;
    }
    case 'pageUp': {
      if (previewing()) { vimScrollPreviewBy(-vp.clientHeight * 0.9); break; }
      const by = Math.max(1, vimViewportLines() - 1);
      vp.scrollTop -= by * LH;
      vimMoveTo(d, d.cur - by * count, d.col || 0, {});
      break;
    }
    case 'jumpBack': go(-count); break;
    case 'jumpFwd': go(count); break;
    case 'nextTab': if (S.tabs.length > 1) switchTab((S.active + count) % S.tabs.length); break;
    case 'prevTab': if (S.tabs.length > 1) switchTab(((S.active - count) % S.tabs.length + S.tabs.length) % S.tabs.length); break;
    case 'visualMode':
      if (vimModeCache === 'visual') vimExitVisual();
      else { vimExitVisual(true); vimEnterVisual(false); }
      break;
    case 'visualLineMode':
      if (vimModeCache === 'visual-line') vimExitVisual();
      else { vimExitVisual(true); vimEnterVisual(true); }
      break;
    case 'normalMode': vimExitVisual(); break;
    case 'yank': vimYank(); break;
    case 'swapEnds': if (vimIsVisual()) { vimVisualSwap = !vimVisualSwap; vimVisualUpdate(); } break;
    case 'searchFwd': vimOpenBar('searchFwd'); break;
    case 'searchBack': vimOpenBar('searchBack'); break;
    case 'searchNext': vimSearchStep(count); break;
    case 'searchPrev': vimSearchStep(-count); break;
    case 'exMode': vimOpenBar('ex'); break;
    default: showToast('!', 'Unknown Vim action: ' + action);
  }
}

/* ---------------- key normalization + dispatch ---------------- */

function vimNormalizeEvent(e) {
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key;
    if (k.length === 1) {
      const lower = k.toLowerCase();
      // Produces 'C-x' candidates, but only keys actually bound in the keymap
      // are consumed (lookup miss => fall through to px0/browser untouched).
      if (/[a-z[\]\\^_]/.test(lower) || k === ']') return 'C-' + (k === ']' ? ']' : lower);
      return null; // let other Ctrl combos (C-p etc.) fall through
    }
    return null;
  }
  if (e.metaKey || e.altKey) return null; // Mod/Alt shortcuts belong to px0
  if (e.key === 'Enter') return 'Enter';
  if (e.key === 'Escape') return 'Escape';
  if (e.key === ' ') return ' ';
  if (e.key && e.key.startsWith('Arrow')) return e.key;
  if (e.key && e.key.length === 1) return e.key;
  return null;
}

function vimLookup(mode, seq) {
  const map = vimKeymap()[mode] || {};
  return map[seq] || null;
}

function vimClearPendingSoon() {
  clearTimeout(vimPendingTimer);
  vimPendingTimer = setTimeout(() => { vimPending = null; vimUpdateChrome(); }, 1500);
}

// Returns true when the event is consumed by Vim.
export function vimHandleKey(e) {
  if (!vimEnabled) return false;
  const target = e.target;
  const inVimInput = target && target.id === 'vim-input';

  // Cmdline input: only command keys are consumed here; text goes to the input.
  // C-c cancels only when there is nothing to copy (browser copy wins).
  if (inVimInput && vimBarKind) {
    if (e.key === 'Enter') { e.preventDefault(); vimAcceptBar(); return true; }
    if (e.key === 'Escape' || (e.ctrlKey && !e.metaKey && !e.altKey && e.key === '[')) { e.preventDefault(); vimCloseBar(); return true; }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      const selCollapsed = target.selectionStart === undefined || target.selectionStart === target.selectionEnd;
      if (selCollapsed) { e.preventDefault(); vimCloseBar(); return true; }
      return false; // let the browser copy the selected cmdline text
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); vimBarHistory(-1); return true; }
    if (e.key === 'ArrowDown') { e.preventDefault(); vimBarHistory(1); return true; }
    if (e.key === 'Tab') { e.preventDefault(); vimBarComplete(); return true; }
    return false;
  }
  // Never steal typing in other fields, the palette, or the help sheet.
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return false;
  if (!$('#helpsheet')?.hidden || !$('#overlay')?.hidden) return false;
  // Never steal activation keys from focused controls (browser-safe: buttons
  // and links keep Enter/Space even with Vim on).
  if (target && (target.tagName === 'BUTTON' || target.tagName === 'A') && (e.key === 'Enter' || e.key === ' ')) return false;

  // Esc / C-[ always drop back to Normal first. (C-c is intentionally NOT an
  // Esc alias here: in a webpage it must keep meaning "copy".)
  if (e.key === 'Escape' || ((e.ctrlKey && !e.metaKey && !e.altKey) && e.key === '[')) {
    if (vimBarKind) { vimCloseBar(); return true; }
    if (vimPending || vimCountBuf) { vimPending = null; vimCountBuf = ''; vimUpdateChrome(); return true; }
    if (vimIsVisual()) { vimExitVisual(); return true; }
    if (S.occ || (S.find && vimOptions().hlsearch)) {
      // Esc clears highlight in Normal (vim hlsearch behavior).
      S.occ = null;
      try { clearFind(); } catch { S.find = null; paint(); }
      return true;
    }
    return false; // let px0's Esc chain (inspector/hover) run
  }

  const key = vimNormalizeEvent(e);
  if (!key) return false;

  const mode = vimIsVisual() ? 'visual' : 'normal';

  // Awaiting f/F/t/T character.
  if (vimPending && vimPending.needChar) {
    const mapKey = vimPending.needChar;
    const count = vimPending.count || 1;
    vimPending = null;
    if (key === 'Escape') { vimUpdateChrome(); return true; }
    if (key.length === 1 && key !== 'Enter') {
      const action = vimLookup(mode, mapKey === 'findCharFwd' ? 'f' : mapKey === 'findCharBack' ? 'F' : mapKey === 'tillCharFwd' ? 't' : 'T');
      // Re-dispatch as the full motion with the typed char.
      vimCountBuf = '';
      vimRunAction(action, count, { ch: key });
      vimUpdateChrome();
      return true;
    }
    vimUpdateChrome();
    return true;
  }

  // g / z / [ / ] prefix pending.
  if (vimPending && vimPending.prefix) {
    const pre = vimPending.prefix;
    const count = vimPending.count || 1;
    const seq = pre + ' ' + key;
    const action = vimLookup(mode, seq);
    vimPending = null;
    vimCountBuf = '';
    if (action) {
      vimRunAction(action, count, {});
      vimUpdateChrome();
      return true;
    }
    // Unknown g-sequence: fall through to single-key handling of `key`.
    vimUpdateChrome();
  }

  // Count prefix.
  if (/^[0-9]$/.test(key) && !(key === '0' && vimCountBuf === '')) {
    // Gutter exception: bare "0" is lineStart (handled below); "10" starts a count.
    vimCountBuf += key;
    vimUpdateChrome();
    return true;
  }

  // Prefix starters.
  if ((key === 'g' || key === 'z' || key === '[' || key === ']') && !e.ctrlKey) {
    const count = vimCountBuf ? parseInt(vimCountBuf, 10) : 1;
    vimPending = { prefix: key, count };
    vimCountBuf = '';
    vimClearPendingSoon();
    vimUpdateChrome();
    return true;
  }

  // Two-key combo check first (e.g. someone mapped "G T"): not needed here
  // since prefixes are handled above; do the single/double lookup.
  const count = vimCountBuf ? parseInt(vimCountBuf, 10) : 1;
  const explicitCount = vimCountBuf !== '';

  // Special-case "gg": g-prefix + g.
  if (key === 'g') {
    // (already handled as prefix starter above; unreachable)
    return true;
  }

  let action = vimLookup(mode, key);
  // "G" with count = goto line; "gg" handled via g-prefix lookup "g g".
  if (!action) return false; // not a Vim key: let px0 handle it (arrows fallback etc.)

  // f-family needs a char: arm pending instead of running.
  if (action === 'findCharFwd' || action === 'findCharBack' || action === 'tillCharFwd' || action === 'tillCharBack') {
    vimPending = { needChar: action, count };
    vimCountBuf = '';
    vimClearPendingSoon();
    vimUpdateChrome();
    return true;
  }

  vimCountBuf = '';
  vimPending = null;
  vimRunAction(action, count, { explicitCount });
  vimUpdateChrome();
  return true;
}

/* ---------------- : / ? bar ---------------- */

function vimBarEls() {
  return { bar: $('#vim-bar'), prefix: $('#vim-bar-prefix'), input: $('#vim-input'), msg: $('#vim-bar-msg') };
}

export function vimOpenBar(kind, seed) {
  const { bar, prefix, input, msg } = vimBarEls();
  if (!bar || !input) return;
  vimBarKind = kind;
  vimModeCache = 'cmdline';
  bar.hidden = false;
  if (prefix) prefix.textContent = kind === 'ex' ? ':' : kind === 'searchBack' ? '?' : '/';
  input.value = seed || '';
  if (msg) { msg.textContent = ''; msg.classList.remove('err'); }
  if (kind === 'ex') { vimExHistIdx = vimExHistory.length; }
  else { vimSearchHistIdx = vimSearchHistory.length; }
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
  vimUpdateChrome();
}

export function vimCloseBar() {
  const { bar, input } = vimBarEls();
  if (bar) bar.hidden = true;
  vimBarKind = null;
  clearTimeout(vimSearchTimer);
  if (vimEnabled && (vimModeCache === 'cmdline')) vimModeCache = vimVisualAnchor ? (vimVisualAnchor.lineMode ? 'visual-line' : 'visual') : 'normal';
  try { input?.blur(); } catch {}
  vimUpdateChrome();
}

export function vimBarMsg(text, isErr) {
  const { msg } = vimBarEls();
  if (!msg) return;
  msg.textContent = text || '';
  msg.classList.toggle('err', !!isErr);
}

function vimBarHistory(delta) {
  const { input } = vimBarEls();
  if (!input) return;
  if (vimBarKind === 'ex') {
    if (!vimExHistory.length) return;
    vimExHistIdx = Math.max(0, Math.min(vimExHistory.length - (delta < 0 ? 0 : 1), vimExHistIdx + delta));
    input.value = vimExHistory[vimExHistIdx] ?? '';
  } else {
    if (!vimSearchHistory.length) return;
    vimSearchHistIdx = Math.max(0, Math.min(vimSearchHistory.length - (delta < 0 ? 0 : 1), vimSearchHistIdx + delta));
    input.value = vimSearchHistory[vimSearchHistIdx] ?? '';
  }
  input.setSelectionRange(input.value.length, input.value.length);
}

function vimBarComplete() {
  const { input } = vimBarEls();
  if (!input || vimBarKind !== 'ex') return;
  const cur = input.value;
  // Complete :b file/tab names and ex command names.
  const m = /^(\s*:?\s*)(b(?:uffer)?|e(?:dit)?)\s+(\S*)$/.exec(cur);
  if (m) {
    const frag = (m[3] || '').toLowerCase();
    const names = S.tabs.map(t => t.path).filter(p => p.toLowerCase().includes(frag)).slice(0, 8);
    vimBarMsg(names.length ? names.join('   ') : 'No matches', !names.length);
    if (names.length === 1) input.value = m[1] + m[2] + ' ' + names[0];
    return;
  }
  const cm = /^(\s*:?\s*)(\w*)$/.exec(cur);
  if (cm) {
    const frag = cm[2].toLowerCase();
    const cmds = [...new Set([...Object.keys(vimExAliases()), 'w', 'q', 'qa', 'e', 'ls', 'b', 'bn', 'bp', 'noh', 'set', 'map', 'theme', 'help', 'diff'])]
      .filter(c => c.toLowerCase().startsWith(frag)).slice(0, 12);
    vimBarMsg(cmds.length ? cmds.join('   ') : 'No commands', !cmds.length);
  }
}

function vimAcceptBar() {
  const { input } = vimBarEls();
  const raw = input ? input.value : '';
  if (vimBarKind === 'searchFwd' || vimBarKind === 'searchBack') {
    const dir = vimBarKind === 'searchBack' ? -1 : 1;
    if (raw.trim()) {
      vimSearchHistory.push(raw);
      if (vimSearchHistory.length > 50) vimSearchHistory.shift();
    }
    vimCloseBar();
    if (raw) vimDoSearch(raw, dir, {});
    return;
  }
  // Ex command.
  const cmd = (raw || '').trim();
  if (cmd) {
    vimExHistory.push(cmd);
    if (vimExHistory.length > 50) vimExHistory.shift();
  }
  vimRunEx(cmd);
}

export async function vimRunEx(raw) {
  const cmd = (raw || '').replace(/^:/, '').trim();
  if (!cmd) { vimCloseBar(); return; }
  // Line numbers / ranges: :42  :3,9
  const range = /^\s*(\d+)\s*(?:,\s*(\d+)\s*)?$/.exec(cmd);
  if (range) {
    const d = doc_();
    if (!d) { vimBarMsg('No file open', true); return; }
    const n = Math.max(1, Math.min(d.total, parseInt(range[2] || range[1], 10)));
    vimCloseBar();
    vimMoveTo(d, n, vimFirstNonBlank(d, n), { center: true, push: true });
    return;
  }
  const m = /^([A-Za-z]+!?)\s*(.*)$/.exec(cmd);
  if (!m) { vimBarMsg('Not an editor command: ' + cmd, true); return; }
  let name = m[1];
  const args = (m[2] || '').trim();
  const aliases = vimExAliases();
  let canon = aliases[name];
  if (!canon && name.endsWith('!')) canon = aliases[name.slice(0, -1)];
  if (!canon) { vimBarMsg('Not an editor command: ' + name, true); return; }
  const ok = await vimExecEx(canon, args, name);
  if (ok === true) vimCloseBar();
  // ok === false keeps the bar open with the message already set.
}

async function vimExecEx(canon, args, rawName) {
  const d = doc_();
  switch (canon) {
    case 'readonlyNoop':
      showToast('!', 'Read-only viewer — nothing to write');
      vimBarMsg('Read-only viewer — nothing to write');
      return false;
    case 'writeQuit':
      showToast('!', 'Read-only viewer — nothing to write');
      vimBarMsg('Read-only viewer — nothing to write (tab kept open)', true);
      return false;
    case 'quit':
      if (!d) { vimBarMsg('No tabs open', true); return false; }
      vimCloseBar();
      closeTab(S.active);
      return true;
    case 'quitAll':
      vimCloseBar();
      while (S.tabs.length) closeTab(0);
      return true;
    case 'only':
      if (!d) return true;
      vimCloseBar();
      for (let i = S.tabs.length - 1; i >= 0; i--) { if (i !== S.active) closeTab(i); }
      return true;
    case 'edit': {
      if (!args) { vimCloseBar(); openPalette('file'); return true; }
      let j;
      try { j = await api('/api/find', { q: args, limit: 10 }); }
      catch (e) { vimBarMsg(e.message, true); return false; }
      if (!j.results || !j.results.length) { vimBarMsg('No file matching "' + args + '"', true); return false; }
      vimCloseBar();
      await openFile(j.results[0].path);
      if (j.results.length > 1) showToast('', 'Opened ' + j.results[0].path + ' (' + j.results.length + ' matches)');
      return true;
    }
    case 'buffers': {
      if (!S.tabs.length) { vimBarMsg('No buffers', true); return false; }
      vimBarMsg(S.tabs.map((t, i) => (i + 1) + ': ' + t.path).join('   '));
      return false;
    }
    case 'buffer': {
      if (!args) { vimBarMsg(':b needs a number or name (see :ls)', true); return false; }
      const n = parseInt(args, 10);
      if (n >= 1 && n <= S.tabs.length) { vimCloseBar(); switchTab(n - 1); return true; }
      const frag = args.toLowerCase();
      const idx = S.tabs.findIndex(t => t.path.toLowerCase().includes(frag) || t.name.toLowerCase().includes(frag));
      if (idx < 0) { vimBarMsg('No buffer matching "' + args + '"', true); return false; }
      vimCloseBar(); switchTab(idx); return true;
    }
    case 'bnext':
      if (S.tabs.length > 1) { vimCloseBar(); switchTab((S.active + 1) % S.tabs.length); return true; }
      vimBarMsg('Only one buffer', true); return false;
    case 'bprev':
      if (S.tabs.length > 1) { vimCloseBar(); switchTab((S.active - 1 + S.tabs.length) % S.tabs.length); return true; }
      vimBarMsg('Only one buffer', true); return false;
    case 'symbols':
      vimCloseBar(); showRightInspector('symbols'); return true;
    case 'nohl':
      S.occ = null;
      try { clearFind(); } catch { S.find = null; paint(); }
      vimCloseBar(); return true;
    case 'set': return vimExSet(args);
    case 'map': return vimExMap(args, 'both');
    case 'unmap': return vimExUnmap(args, 'both');
    case 'mapclear':
      vimClearKeymapDeltas();
      vimKeymapCache = null;
      vimBarMsg('Custom Vim bindings cleared (defaults restored)');
      return false;
    case 'theme': {
      if (!args) { vimCloseBar(); openPalette('theme'); return true; }
      if (setTheme(args)) { vimCloseBar(); return true; }
      const hit = listThemes().find(t => t.id.toLowerCase() === args.toLowerCase() || t.name.toLowerCase() === args.toLowerCase());
      if (hit && setTheme(hit.id)) { vimCloseBar(); return true; }
      vimBarMsg('Unknown theme: ' + args, true); return false;
    }
    case 'help':
      vimCloseBar();
      document.querySelector('#btn-help')?.click();
      return true;
    case 'diff':
      vimCloseBar(); toggleDiff(); return true;
    case 'vimtoggle':
      vimCloseBar(); toggleVim(); return true;
    default:
      vimBarMsg('Not implemented: ' + rawName, true);
      return false;
  }
}

function vimExSet(args) {
  const opts = vimOptions();
  const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    vimBarMsg(Object.entries(opts).map(([k, v]) => (v ? '' : 'no') + k).join('   '));
    return false;
  }
  for (let tok of tokens) {
    let query = false, toggle = false;
    if (tok.endsWith('?')) { query = true; tok = tok.slice(0, -1); }
    else if (tok.endsWith('!')) { toggle = true; tok = tok.slice(0, -1); }
    const neg = tok.startsWith('no') && tok.length > 2 && (tok.slice(2) in opts);
    const key = neg ? tok.slice(2) : tok;
    if (!(key in opts) && key !== 'vim' && key !== 'wrap' && key !== 'number') {
      vimBarMsg('Unknown option: ' + tok, true);
      return false;
    }
    const get = () => key === 'vim' ? vimEnabled : key === 'wrap' ? S.wrap : key === 'number' ? S.lineNumbers : !!opts[key];
    if (query) {
      vimBarMsg(key + '=' + (get() ? 'on' : 'off'));
      return false;
    }
    let val = neg ? false : true;
    if (toggle) val = !get();
    if (key === 'vim') {
      if (val !== vimEnabled) { vimCloseBar(); setVimEnabled(val); return true; }
    } else if (key === 'wrap') {
      toggleWordWrap(val);
    } else if (key === 'number') {
      toggleLineNumbers(val);
    } else {
      opts[key] = val;
    }
  }
  vimSaveOptions(opts);
  vimOptionsCache = opts;
  if (opts.relativenumber && vimEnabled) vimApplyRelativeNumbers();
  else if (vimEnabled) render();
  vimBarMsg(Object.entries(opts).map(([k, v]) => (v ? '' : 'no') + k).join('   '));
  return false;
}

function vimNormLhs(lhs) {
  return lhs.replace(/<(C|Ctrl)-([A-Za-z\[\]\\])>/gi, (_, __, k) => 'C-' + k.toLowerCase())
    .replace(/^C-(.)$/, (_, k) => 'C-' + k.toLowerCase());
}

function vimExMap(args, scope) {
  const parts = (args || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const map = vimKeymap();
    console.table({ ...map.normal });
    vimBarMsg(Object.keys(map.normal).length + ' normal bindings (full list in console)');
    return false;
  }
  if (parts.length < 2) { vimBarMsg('Usage: :map <lhs> <action>  (e.g. :map J halfDown)', true); return false; }
  const lhs = vimNormLhs(parts[0]);
  const action = parts[1];
  if (!VIM_ACTIONS[action]) {
    vimBarMsg('Unknown action "' + action + '". Actions: ' + Object.keys(VIM_ACTIONS).slice(0, 8).join(', ') + '…', true);
    return false;
  }
  const modes = scope === 'both' ? ['normal', 'visual'] : [scope];
  for (const m of modes) vimSaveKeymapDelta(m, lhs, action);
  vimKeymapCache = null;
  vimBarMsg('Mapped ' + lhs + ' -> ' + action + ' (' + modes.join('/') + ')');
  return false;
}

function vimExUnmap(args, scope) {
  const lhs = vimNormLhs((args || '').trim());
  if (!lhs) { vimBarMsg('Usage: :unmap <lhs>', true); return false; }
  const modes = scope === 'both' ? ['normal', 'visual'] : [scope];
  for (const m of modes) vimSaveKeymapDelta(m, lhs, null);
  vimKeymapCache = null;
  vimBarMsg('Unmapped ' + lhs);
  return false;
}

/* ---------------- relative numbers ---------------- */

function vimApplyRelativeNumbers() {
  const d = doc_();
  if (!d || !vimEnabled || !vimOptions().relativenumber) return;
  for (const r of rowsEl.children) {
    const n = +r.dataset.l;
    const g = r.firstElementChild;
    if (!g) continue;
    g.textContent = n === d.cur ? String(n) : String(Math.abs(n - d.cur));
  }
}

function vimInitRelativeObserver() {
  if (vimRelObserver || !rowsEl) return;
  vimRelObserver = new MutationObserver(() => {
    if (vimEnabled && vimOptions().relativenumber) vimApplyRelativeNumbers();
  });
  vimRelObserver.observe(rowsEl, { childList: true });
}

/* ---------------- help ---------------- */

export function vimHelpHTML() {
  const map = vimKeymap();
  const rows = [
    ['Modes', 'v / V visual · Esc normal · : cmd · / ? search · n/N repeat'],
    ['Move', 'h j k l · w W b B e E · 0 $ ^ · f F t T ; , · % · d/u half page · PgUp/PgDn'],
    ['Leap', ']] / [[ next/prev symbol · } / { next/prev blank line (counts work)'],
    ['Files', ':e <name> · :ls · :b <n> · :bn/:bp · gt/gT · Alt+Left/Right history'],
    ['Quit', ':q · :qa · :only (read-only: :w is a no-op)'],
    ['LSP', 'gd definition · gr references · gh calls · K inspect'],
    ['Opts', ':set hlsearch/ignorecase/relativenumber · :map/:unmap · docs/vim.md'],
  ];
  const keys = Object.entries(map.normal).slice(0, 40).map(([k, a]) => k + '→' + a).join(' · ');
  return '<div class="help-card"><div class="help-header"><h2>Vim Navigation</h2></div><dl class="help-grid">' +
    rows.map(([k, v]) => '<dt><kbd>' + k + '</kbd></dt><dd>' + v + '</dd>').join('') +
    '</dl><p class="hint" style="margin:12px 0 0">' + keys + '</p></div>';
}

/* ---------------- init ---------------- */

export function initVim() {
  vimEnabled = vimReadEnabledPref();
  vimOptionsCache = vimLoadOptions();
  document.body.classList.toggle('vim-on', vimEnabled);
  vimUpdateChrome();
  vimInitRelativeObserver();
  // Live incremental search while typing / or ? (debounced; Enter accepts).
  document.addEventListener('input', e => {
    if (!vimEnabled || !vimBarKind || vimBarKind === 'ex') return;
    if (e.target && e.target.id === 'vim-input') {
      clearTimeout(vimSearchTimer);
      const q = e.target.value;
      const dir = vimBarKind === 'searchBack' ? -1 : 1;
      if (!q) return;
      vimSearchTimer = setTimeout(() => {
        if (vimBarKind) vimDoSearch(q, dir, { live: true });
      }, 280);
    }
  });
  // Keep the mode chip honest across tab switches.
  document.addEventListener('click', e => {
    if (vimEnabled && e.target && e.target.closest && e.target.closest('.tab')) {
      setTimeout(() => { vimUpdateChrome(); if (vimOptions().relativenumber) vimApplyRelativeNumbers(); }, 30);
    }
  });
}
