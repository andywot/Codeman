/**
 * @fileoverview Chat view (fork): a Claude session as a conversation, the way the
 * Claude phone app shows it, with the live terminal one tap away.
 *
 * The conversation comes from Claude Code's own log (GET /api/sessions/:id/chat,
 * src/chat-transcript.ts), read by byte offset, for local and remote sessions alike.
 * A saved copy (IndexedDB, chat-core.js) paints first, then only what is new is
 * fetched. One read at a time, on a pace set by chat-core.js; events from the stream
 * say when to read sooner, and the timer is the fallback. Replies render as markdown; tool calls fold into one
 * "Ran 3 commands, read 2 files" line per stretch of work that expands to each call
 * and its output; files Claude writes or edits become cards that open the file
 * preview; a question (AskUserQuestion) or permission prompt that is waiting on
 * you becomes a card of buttons. Those options come from the approvals list, which
 * re-reads the pane on the server, and each answer is checked against a fresh read
 * before a key is pressed. Answers are never queued: without a live link they are
 * disabled and the card says why.
 *
 * Composer: a contenteditable box (a phone keyboard will paste images into it,
 * which it refuses for the terminal's plain textarea), an attach button, and send.
 * While Claude works, send queues the message into the running turn (Claude Code's
 * own queue), "Send now" interrupts first, and the empty-composer button stops.
 * A sent message shows at once and is saved until the server ACKs it. It goes out
 * through the browser input layer in app.js (one whole prompt, one seq), so it lands
 * exactly once; the outbox here only decides WHEN it is handed over (chat-core.js).
 *
 * Phone (< 768px): sessions open in a full-screen conversation with a back arrow to
 * the phone home. The terminal is the header's terminal button; the browser back
 * gesture returns home. Desktop stays on the terminal, with a Chat / Terminal switch.
 * The choice is remembered per device (`codeman:chatMode`). While chat covers a
 * session the main terminal is PARKED (`_chatParksTerminal`): no capture, no resize,
 * no socket. It loads when asked for.
 *
 * With no server state yet (slow link, or offline from the service worker's shell) the
 * last conversation, or a list of saved ones, shows from `codeman:chatDirectory`.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (_renderMarkdown, _linkifyFilePaths, _bindResponseViewerInteractions, _sendInputAsync)
 * @dependency image-input.js (_normalizeImageForUpload, _uploadPasteImage)
 * @dependency app.js (_reliableSend, the exactly-once input layer)
 * @dependency chat-core.js (CodemanChatCore)
 * @dependency home-sessions.js (buildHomeSessionRows)
 * @dependency panels-ui.js (openFilePreview)
 * @loadorder after status-bar.js
 */

/** How often the screen is redrawn from what is already known. Reads no network. */
const CHAT_TICK_MS = 1500;
// A phone on its side is wider than the width gate, and still a phone.
const CHAT_PHONE_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';
const CHAT_MODE_KEY = 'codeman:chatMode';
const CHAT_OUTBOX_KEY = 'codeman:chatOutbox';
const CHAT_DIRECTORY_KEY = 'codeman:chatDirectory';
/** Most conversation rows drawn at once; scrolling up draws more. */
const CHAT_RENDER_WINDOW = 150;
/** SSE filter while parked: no session matches, so no terminal output is streamed. */
const CHAT_SSE_FILTER = 'chat-parked';
/** Events that mean the log has probably grown. A read follows, or the timer catches it. */
const CHAT_NUDGE_EVENTS = [
  'session:working',
  'session:idle',
  'hook:stop',
  'hook:idle_prompt',
  'hook:permission_prompt',
  'hook:elicitation_dialog',
  'hook:prompt_submitted',
  'transcript:tool_start',
  'transcript:tool_end',
  'transcript:complete',
  'approval:pending',
  'approval:resolved',
];
const chatCore = () => window.CodemanChatCore;
const CHAT_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CHAT_STATE_LABEL = {
  needs: 'Needs you',
  error: 'Error',
  waiting: 'Your turn',
  working: 'Working',
  idle: 'Idle',
  unknown: 'Unknown',
  done: 'Stopped',
  exited: 'Exited',
};

const chatIcon = (body, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const CHAT_ICONS = {
  back: chatIcon('<path d="M19 12H5M12 19l-7-7 7-7"/>', 22),
  terminal: chatIcon('<path d="M4 17l6-5-6-5M12 19h8"/>', 20),
  chat: chatIcon('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>', 20),
  more: chatIcon('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>', 20),
  plus: chatIcon('<path d="M12 5v14M5 12h14"/>', 20),
  send: chatIcon('<path d="M12 19V5M5 12l7-7 7 7"/>', 20),
  stop: '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>',
  chevron: chatIcon('<path d="M9 18l6-6-6-6"/>', 16),
  file: chatIcon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>', 18),
  copy: chatIcon('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', 14),
  close: chatIcon('<path d="M18 6L6 18M6 6l12 12"/>', 14),
  agent: chatIcon('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 18),
  artifact: chatIcon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>', 16),
};

function chatEsc(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function chatBasename(path) {
  const s = String(path || '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s;
}

function chatOneLine(text, max = 120) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Title line for one tool call, the way the app's activity list words it. */
function chatToolTitle(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash':
      return i.description ? String(i.description) : chatOneLine(i.command, 90);
    case 'BashOutput':
      return 'Read background output';
    case 'KillShell':
      return 'Stopped a background command';
    case 'Read':
      return `Read ${chatBasename(i.file_path)}`;
    case 'Write':
      return `Wrote ${chatBasename(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${chatBasename(i.file_path)}`;
    case 'Grep':
      return `Searched for ${chatOneLine(i.pattern, 60)}`;
    case 'Glob':
      return `Found files ${chatOneLine(i.pattern, 60)}`;
    case 'WebFetch':
      return `Fetched ${chatOneLine(i.url, 70)}`;
    case 'WebSearch':
      return `Searched the web for ${chatOneLine(i.query, 60)}`;
    case 'Task':
    case 'Agent':
      return `Agent: ${chatOneLine(i.description || i.prompt, 70)}`;
    case 'TodoWrite':
      return 'Updated the plan';
    case 'AskUserQuestion':
      return 'Asked you';
    default:
      return name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
  }
}

/** "Ran 3 commands, read 2 files" for a run of tool calls. */
function chatActivitySummary(tools) {
  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
  for (const t of tools) {
    if (t.name === 'Bash' || t.name === 'BashOutput') bump('command');
    else if (t.name === 'Read') bump('read');
    else if (t.name === 'Grep' || t.name === 'Glob') bump('search');
    else if (t.name === 'WebFetch' || t.name === 'WebSearch') bump('web');
    else if (t.name === 'Task' || t.name === 'Agent') bump('agent');
    else if (CHAT_FILE_TOOLS.has(t.name)) bump('edit');
    else bump('tool');
  }
  const n = (k) => counts.get(k) || 0;
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  const parts = [];
  if (n('command')) parts.push(`ran ${plural(n('command'), 'command', 'commands')}`);
  if (n('read')) parts.push(`read ${plural(n('read'), 'file', 'files')}`);
  if (n('search')) parts.push(`searched ${plural(n('search'), 'time', 'times')}`);
  if (n('web')) parts.push(`browsed ${plural(n('web'), 'page', 'pages')}`);
  if (n('agent')) parts.push(`ran ${plural(n('agent'), 'agent', 'agents')}`);
  if (n('edit')) parts.push(`edited ${plural(n('edit'), 'file', 'files')}`);
  if (n('tool')) parts.push(`used ${plural(n('tool'), 'tool', 'tools')}`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A slash command's own log records: `<command-name>` (the command), and
 * `<local-command-stdout>` (what it printed, ANSI colors stripped). Returns an item,
 * null for a record to hide, or undefined when `raw` is not one of them.
 */
function localCommandItem(raw, key) {
  const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = (raw.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || '';
    return { kind: 'user', key, text: `${command[1]} ${args}`.trim(), command: true };
  }
  const stdout = raw.match(/^<local-command-std(?:out|err)>([\s\S]*)<\/local-command-std(?:out|err)>$/);
  if (!stdout) return undefined;
  const out = stdout[1]
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\[[0-9;]+m/g, '')
    .trim();
  // The compaction row already says this.
  if (!out || /^Compacted\b/.test(out)) return null;
  const lines = out.split('\n');
  return lines.length > 2 || out.length > 300
    ? { kind: 'output', key, title: chatOneLine(lines[0], 120), text: out }
    : { kind: 'note', key, text: chatOneLine(out, 300) };
}

/**
 * Pictures attached from chat reach the log as paths in the message text. Returns the text
 * without them and the paths, so the bubble can draw the pictures. Pure.
 */
function chatSplitUploads(text) {
  const uploads = [];
  const rest = String(text || '')
    .replace(/(^|\s)(\S*[\\/]\.codeman-uploads[\\/]\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi, (_m, gap, path) => {
      uploads.push(path);
      return gap;
    })
    .trim();
  return { text: rest, uploads };
}

/** A claude.ai artifact link in a tool call's input or result, or ''. Pure. */
function chatArtifactUrl(tool) {
  const hay = `${tool.input?.url || ''}\n${tool.result?.text || ''}`;
  return (hay.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/) || [''])[0];
}

/** The newest title for each artifact the conversation touched, most recent first. Pure. */
function chatArtifacts(items) {
  const byUrl = new Map();
  for (const item of items) {
    if (item.kind !== 'artifact' || !item.url) continue;
    const title = item.tool.result?.title || byUrl.get(item.url)?.title || item.tool.input?.title || '';
    byUrl.delete(item.url);
    byUrl.set(item.url, { url: item.url, title });
  }
  return [...byUrl.values()].reverse();
}

/** What a tool call is doing, for the working line. Pure. */
function chatRunningLabel(items) {
  for (let i = items.length - 1; i >= 0 && i >= items.length - 4; i--) {
    const tools = items[i].tools || (items[i].tool ? [items[i].tool] : []);
    const running = tools.filter((t) => !t.result).pop();
    if (running) return chatToolTitle(running.name, running.input);
  }
  return '';
}

/** Slash commands of Claude Code itself; `menu` ones open a dialog only the terminal can show. */
const CHAT_BUILTIN_COMMANDS = [
  ['clear', 'Start a new conversation'],
  ['compact', 'Summarize the conversation to free up context'],
  ['context', 'Show what is using the context'],
  ['cost', 'Show what this session has used'],
  ['usage', 'Show plan usage limits'],
  ['init', 'Write a CLAUDE.md for this project'],
  ['review', 'Review a pull request'],
  ['model', 'Choose the model', true],
  ['effort', 'Choose the effort level', true],
  ['resume', 'Go back to a past conversation', true],
  ['rewind', 'Go back to an earlier point', true],
  ['config', 'Open settings', true],
  ['permissions', 'Manage tool permissions', true],
  ['mcp', 'Manage MCP servers', true],
  ['agents', 'Manage agents', true],
  ['memory', 'Edit memory files', true],
  ['login', 'Sign in', true],
  ['logout', 'Sign out', true],
].map(([name, description, menu]) => ({ name, description, menu: !!menu }));

/** The picker's rows for what is typed, or null when the box is not a command being typed. Pure. */
function chatSlashMatches(typed, skills) {
  const m = String(typed || '').match(/^\/([^\s/]*)$/);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const seen = new Set();
  const all = [...CHAT_BUILTIN_COMMANDS, ...(skills || [])].filter((c) => !seen.has(c.name) && seen.add(c.name));
  const rank = (c) => {
    const at = c.name.toLowerCase().indexOf(q);
    return at === 0 ? 0 : at > 0 ? 1 : 2;
  };
  return all
    .filter((c) => rank(c) < 2)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 8);
}

/**
 * Turn log entries into display items. Pure; exported for tests.
 * Items: user, text, thinking, activity (a run of tool calls), file, question, todo, note,
 * compact (a /compact point with its summary), output (a slash command's long output),
 * agent (a subagent, opens its own log), artifact (a page Claude published or opened).
 */
function buildChatItems(entries) {
  const results = new Map();
  for (const e of entries) {
    if (e.role !== 'user') continue;
    for (const b of e.blocks) if (b.type === 'tool_result' && b.toolUseId) results.set(b.toolUseId, b);
  }
  const items = [];
  let activity = null;
  let compact = null;
  const flush = () => {
    activity = null;
  };
  // Claude Code logs a typed slash command twice (the prompt, then its <command-name>
  // record); keep one.
  const push = (item) => {
    if (item.kind === 'user' && item.command) {
      // Look back past what the command itself produced (a compaction row, notes).
      for (let i = items.length - 1; i >= Math.max(0, items.length - 3); i--) {
        const prev = items[i];
        if (prev.kind === 'compact' || prev.kind === 'note') continue;
        if (prev.kind === 'user' && prev.text.trim() === item.text) {
          prev.command = true;
          return;
        }
        break;
      }
    }
    items.push(item);
  };
  for (const e of entries) {
    if (e.sidechain) continue;
    if (e.role === 'system') {
      flush();
      if (e.compacted) {
        compact = { kind: 'compact', key: e.uuid, before: e.compacted.before, after: e.compacted.after, text: '' };
        items.push(compact);
        continue;
      }
      const text = e.blocks
        .map((b) => b.text || '')
        .join('\n')
        .trim();
      if (!text) continue;
      const local = localCommandItem(text, e.uuid);
      if (local !== undefined) {
        if (local) push(local);
      } else items.push({ kind: 'note', key: e.uuid, text: chatOneLine(text, 200) });
      continue;
    }
    if (e.role === 'user') {
      if (e.meta) continue;
      const texts = e.blocks.filter((b) => b.type === 'text').map((b) => b.text || '');
      const images = e.blocks.filter((b) => b.type === 'image' && b.len);
      if (!texts.length && !images.length) continue;
      const raw = texts.join('\n').trim();
      if (e.compactSummary) {
        // The summary written after /compact: folded into the compaction row.
        if (!compact) {
          compact = { kind: 'compact', key: e.uuid, before: 0, after: 0, text: '' };
          items.push(compact);
        }
        compact.text = raw;
        continue;
      }
      if (/^<(local-command-caveat|system-reminder)>/.test(raw)) continue;
      flush();
      const local = localCommandItem(raw, e.uuid);
      if (local !== undefined) {
        if (local) push(local);
        continue;
      }
      if (/^\[Request interrupted by user/.test(raw)) {
        items.push({ kind: 'note', key: e.uuid, text: 'Interrupted' });
        continue;
      }
      // Pasted images: drawn in the bubble, so drop Claude Code's "[Image #N]" stand-ins.
      const text = images.length ? raw.replace(/\s*\[Image #\d+\]/g, '').trim() : raw;
      push({ kind: 'user', key: e.uuid, text, images, queued: !!e.queued, at: e.timestamp });
      continue;
    }
    // assistant
    for (let i = 0; i < e.blocks.length; i++) {
      const b = e.blocks[i];
      const key = `${e.uuid}:${i}`;
      if (b.type === 'text') {
        flush();
        items.push({ kind: 'text', key, text: b.text || '' });
      } else if (b.type === 'thinking') {
        flush();
        items.push({ kind: 'thinking', key, text: b.text || '' });
      } else if (b.type === 'tool_use') {
        const result = results.get(b.id) || null;
        const tool = { id: b.id, name: b.name, input: b.input || {}, result };
        if (b.name === 'AskUserQuestion') {
          flush();
          items.push({ kind: 'question', key, tool });
        } else if (b.name === 'TodoWrite') {
          flush();
          items.push({ kind: 'todo', key, tool });
        } else if (b.name === 'Agent' || b.name === 'Task') {
          flush();
          items.push({ kind: 'agent', key, tool });
        } else if (
          b.name === 'Artifact' &&
          chatArtifactUrl(tool) &&
          /^(publish|read|open|pin)?$/.test(b.input?.action || '')
        ) {
          flush();
          items.push({ kind: 'artifact', key, tool, url: chatArtifactUrl(tool) });
        } else {
          if (!activity) {
            activity = { kind: 'activity', key, tools: [] };
            items.push(activity);
          }
          activity.tools.push(tool);
          if (CHAT_FILE_TOOLS.has(b.name)) {
            items.push({ kind: 'file', key: `${key}:file`, tool });
            activity = null;
          }
        }
      }
    }
  }
  return items;
}

/** Changes when a row must be redrawn: a tool got its result, a text grew. */
function chatItemSignature(item) {
  const tools = item.tools || (item.tool ? [item.tool] : []);
  return [
    item.kind,
    (item.text || '').length,
    item.command ? 1 : 0,
    item.queued ? 1 : 0,
    (item.images || []).length,
    tools.map((t) => (t.result ? (t.result.isError ? 2 : 1) : 0)).join(''),
    item.title || '',
    item.after || 0,
  ].join('|');
}

/** Numbered options on the bottom of a terminal screen (permission and question dialogs). */
function parseScreenOptions(lines) {
  const clean = lines.map((l) => l.replace(/[│╭╮╰╯─┃┏┓┗┛━]/g, ' ').replace(/\s+$/, ''));
  let last = -1;
  const optionRe = /^\s*(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
  for (let i = clean.length - 1; i >= 0; i--) {
    if (optionRe.test(clean[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const options = [];
  let first = last;
  for (let i = last; i >= 0 && last - i < 30; i--) {
    const m = clean[i].match(optionRe);
    if (m) {
      options.unshift({ key: m[1], label: m[2].trim(), selected: /^\s*[❯›>]/.test(clean[i]) });
      first = i;
      if (m[1] === '1') break;
    }
  }
  if (!options.length || options[0].key !== '1') return null;
  let title = '';
  for (let i = first - 1; i >= 0 && first - i < 8; i--) {
    const t = clean[i].trim();
    if (t && !/^[-=_.·\s]+$/.test(t)) {
      title = t;
      break;
    }
  }
  return { title, options };
}

/**
 * Context window for a model id. Claude Code's 5-series models run with a 1M window
 * (what `/context` reports for them); older ids default to 200k unless tagged [1m].
 */
function chatContextLimit(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('[1m]') || /claude-(opus|sonnet|fable)-5/.test(m)) return 1_000_000;
  return 200_000;
}

/** The newest context reading in a list of log entries, or null. */
function latestChatContext(entries) {
  let compacted = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.sidechain) continue;
    // After /compact the next reading comes with the next reply; until then use its size.
    if (e.compacted && compacted === null) compacted = e.compacted.after;
    if (e.role === 'assistant' && e.usage && e.usage.context > 0) {
      const used = compacted !== null ? compacted : e.usage.context;
      return { used, limit: chatContextLimit(e.model), model: e.model || '' };
    }
  }
  return null;
}

function chatTokens(n) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`;
}

if (typeof window !== 'undefined') {
  window.CodemanChat = {
    buildChatItems,
    parseScreenOptions,
    chatActivitySummary,
    chatToolTitle,
    chatContextLimit,
    latestChatContext,
    chatTokens,
    chatSplitUploads,
    chatArtifactUrl,
    chatArtifacts,
    chatRunningLabel,
    chatSlashMatches,
  };
}

Object.assign(CodemanApp.prototype, {
  // ── State ───────────────────────────────────────────────────────────────
  _chatIsPhone() {
    return window.matchMedia?.(CHAT_PHONE_QUERY).matches ?? window.innerWidth < 768;
  },

  _chatMode() {
    let stored = null;
    try {
      stored = localStorage.getItem(CHAT_MODE_KEY);
    } catch {
      /* storage blocked */
    }
    return chatCore().chatModeFor(stored, this._chatIsPhone());
  },

  setChatMode(mode) {
    const before = this._chatMode();
    try {
      localStorage.setItem(CHAT_MODE_KEY, mode);
    } catch {
      /* storage blocked */
    }
    this.chatSync();
    if (mode === before) return;
    const id = this.activeSessionId;
    if (!id) return;
    if (mode === 'terminal') {
      // The terminal was parked: load it now, the way a tab switch does.
      if (this.sessions?.has(id)) void this.selectSession(id, { forceReload: true, auto: true });
      setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    } else if (this._chatParksTerminal(id)) {
      this._disconnectWs?.();
      this._wsState = 'fallback';
      this._updateConnectionIndicator?.();
      this._updateSseSubscription?.(id);
    }
    this._chatKick();
  },

  /** Chat is on screen for this session, so the main terminal stands aside. */
  _chatParksTerminal(id) {
    if (!id || this._chatMode() !== 'chat') return false;
    if (this._tilesOwnTerminal?.()) return false;
    return this._chatSupported(id);
  },

  _chat(id) {
    if (!this._chatSessions) this._chatSessions = new Map();
    let s = this._chatSessions.get(id);
    if (!s) {
      s = {
        log: null,
        start: 0,
        end: 0,
        entries: [],
        loaded: false,
        busy: false,
        found: true,
        draft: '',
        uploads: [],
        nodes: new Map(),
        visibleFrom: null,
        updatedAt: 0,
      };
      this._chatSessions.set(id, s);
    }
    return s;
  },

  _chatCache() {
    if (!this._chatCacheStore) this._chatCacheStore = chatCore().createChatCache();
    return this._chatCacheStore;
  },

  // ── Saved session list (what the page knows before the server answers) ──
  _chatDirectory() {
    if (!this._chatDirectoryData) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(CHAT_DIRECTORY_KEY) || 'null');
      } catch {
        /* storage blocked, or a bad value */
      }
      this._chatDirectoryData = saved && typeof saved === 'object' ? saved : {};
    }
    return this._chatDirectoryData;
  },

  /** Keep the saved list in step with the server's, and forget sessions that have gone. */
  _chatRefreshDirectory() {
    if (!(this._initGeneration > 0) || !this.sessions) return;
    const next = {};
    for (const [id, session] of this.sessions) {
      if (!this._chatSupported(id)) continue;
      next[id] = {
        name: this.getSessionName ? this.getSessionName(session) : session.name || '',
        mode: session.mode,
        where: session.remote ? session.remote.label || session.remote.hostId : 'This server',
        folder: session.remote?.remotePath || session.workingDir || '',
        model: session.displayModel?.model || session.model || '',
        state: this._chatRowState(id)?.state || 'idle',
      };
    }
    const before = this._chatDirectory();
    const text = JSON.stringify(next);
    if (text === this._chatDirectoryText) return;
    this._chatDirectoryText = text;
    for (const id of Object.keys(before)) {
      if (!next[id]) void this._chatCache().remove(id);
    }
    this._chatDirectoryData = next;
    try {
      localStorage.setItem(CHAT_DIRECTORY_KEY, text);
    } catch {
      /* storage blocked: the list lasts as long as the page */
    }
  },

  /** What is shown: the active session, or before the server answers, the last one. */
  _chatDisplayId() {
    if (this.activeSessionId) return this.activeSessionId;
    if (this._initGeneration > 0) return null;
    if (this._chatOfflineId === undefined) {
      let stored = null;
      try {
        stored = localStorage.getItem('codeman-active-session');
      } catch {
        /* storage blocked */
      }
      this._chatOfflineId = stored && this._chatDirectory()[stored] ? stored : null;
    }
    return this._chatOfflineId;
  },

  _chatSupported(id) {
    const session = this.sessions?.get(id);
    if (!session) return !(this._initGeneration > 0) && !!this._chatDirectory()[id];
    // Registry data, never a CLI id: only a CLI that keeps a Claude-format log has a chat.
    const catalog = Array.isArray(window.__codemanCliCatalog) ? window.__codemanCliCatalog : [];
    return catalog.some((entry) => entry.id === session.mode && entry.transcript === 'claude-jsonl');
  },

  // ── DOM ─────────────────────────────────────────────────────────────────
  _chatViewEl() {
    let el = document.getElementById('chatView');
    if (el) return el;
    const wrap = document.querySelector('.terminal-wrap');
    if (!wrap) return null;
    el = document.createElement('section');
    el.id = 'chatView';
    el.className = 'chat-view';
    el.hidden = true;
    el.setAttribute('aria-label', 'Conversation');
    el.setAttribute('data-i18n-skip', '');
    el.innerHTML = `
      <header class="chat-head">
        <button type="button" class="chat-icon-btn chat-back" data-chat="back" aria-label="All sessions">${CHAT_ICONS.back}</button>
        <div class="chat-head-title">
          <div class="chat-title"></div>
          <div class="chat-subtitle"></div>
        </div>
        <span class="chat-spinner" aria-hidden="true"></span>
        <div class="chat-switch" role="group" aria-label="View">
          <button type="button" data-chat="mode-chat" aria-pressed="true">Chat</button>
          <button type="button" data-chat="mode-terminal" aria-pressed="false">Terminal</button>
        </div>
        <button type="button" class="chat-icon-btn chat-to-terminal" data-chat="mode-terminal" aria-label="Show terminal" title="Terminal">${CHAT_ICONS.terminal}</button>
        <button type="button" class="chat-icon-btn" data-chat="options" aria-label="Session options" title="Session options">${CHAT_ICONS.more}</button>
      </header>
      <div class="chat-link" role="status" hidden></div>
      <div class="chat-pins" hidden></div>
      <div class="chat-scroll">
        <div class="chat-log" role="log" aria-live="polite"></div>
        <div class="chat-outbox" aria-live="polite"></div>
      </div>
      <div class="chat-agent-sheet" hidden>
        <header class="chat-agent-head">
          <button type="button" class="chat-icon-btn" data-chat="close-agent" aria-label="Back to the conversation">${CHAT_ICONS.back}</button>
          <div class="chat-agent-title"></div>
        </header>
        <div class="chat-agent-scroll"><div class="chat-log chat-agent-log"></div></div>
      </div>
      <div class="chat-dock">
        <div class="chat-slash" hidden role="listbox" aria-label="Commands"></div>
        <div class="chat-prompt" hidden></div>
        <div class="chat-status" hidden></div>
        <div class="chat-composer">
          <div class="chat-uploads" hidden></div>
          <div class="chat-input" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message" data-placeholder="Reply to Claude…" enterkeyhint="enter"></div>
          <div class="chat-composer-row">
            <button type="button" class="chat-round chat-attach" data-chat="attach" aria-label="Attach photos or files" title="Attach">${CHAT_ICONS.plus}</button>
            <span class="chat-model" title="Model"></span>
            <span class="chat-context" hidden></span>
            <span class="chat-row-spacer"></span>
            <button type="button" class="chat-pill chat-sendnow" data-chat="send-now" hidden title="Interrupt Claude and send this now">Send now</button>
            <button type="button" class="chat-round chat-send" data-chat="send" aria-label="Send">${CHAT_ICONS.send}</button>
          </div>
          <input type="file" class="chat-file" multiple hidden accept="image/*,.pdf,.docx,.pptx,.xlsx,.zip,.txt,.md,.csv,.tsv,.json,.log,.yaml,.yml,.xml">
        </div>
      </div>`;
    wrap.appendChild(el);
    this._chatWire(el);
    return el;
  },

  _chatHomeEl() {
    let el = document.getElementById('chatHome');
    if (el) return el;
    el = document.createElement('section');
    el.id = 'chatHome';
    el.className = 'chat-home';
    el.hidden = true;
    el.setAttribute('aria-label', 'Sessions');
    el.setAttribute('data-i18n-skip', '');
    el.innerHTML = `
      <header class="chat-home-head">
        <div class="chat-home-brand"><span class="chat-home-mark" aria-hidden="true"></span><span class="chat-home-name"></span></div>
        <button type="button" class="chat-icon-btn" data-chat="terminal-home" aria-label="Terminal view" title="Terminal view">${CHAT_ICONS.terminal}</button>
        <button type="button" class="chat-icon-btn" data-chat="settings" aria-label="Settings" title="Settings">${chatIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', 20)}</button>
      </header>
      <div class="chat-link" role="status" hidden></div>
      <div class="chat-home-search"><input type="search" placeholder="Search sessions" aria-label="Search sessions" autocomplete="off" spellcheck="false"></div>
      <div class="chat-home-list"></div>
      <div class="chat-home-foot">
        <button type="button" class="chat-new" data-chat="new">${CHAT_ICONS.plus}<span>New session</span></button>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (event) => {
      const row = event.target.closest('[data-session]');
      if (row) {
        this.chatOpenSession(row.dataset.session);
        return;
      }
      const action = event.target.closest('[data-chat]')?.dataset.chat;
      if (action === 'new') this.openNewSessionFlow?.();
      else if (action === 'settings') this.openAppSettings?.();
      else if (action === 'terminal-home') this.setChatMode('terminal');
      else if (action === 'retry') this._chatRetryNow();
      else if (action === 'signin') this._chatSignIn();
    });
    el.querySelector('input[type="search"]').addEventListener('input', () => this._chatRenderHome());
    return el;
  },

  // ── Navigation ──────────────────────────────────────────────────────────
  /** Open one session's conversation. */
  chatOpenSession(id) {
    if (!id) return;
    if (this._initGeneration > 0 && this.sessions?.has(id)) {
      if (this.activeSessionId !== id) this.selectSession(id);
    } else {
      // Nothing from the server yet: read the saved copy.
      this._chatOfflineId = id;
      try {
        localStorage.setItem('codeman-active-session', id);
      } catch {
        /* storage blocked */
      }
    }
    this.chatSync();
  },

  chatBackToList() {
    if (history.state?.chat === 'session') {
      history.back();
      return;
    }
    this._chatGoHome();
  },

  _chatGoHome() {
    this._chatOfflineId = null;
    if (this.activeSessionId) this.goHome?.();
    else {
      try {
        localStorage.removeItem('codeman-active-session');
      } catch {
        /* storage blocked */
      }
    }
    this.chatSync();
  },

  /** Decide what is on screen. Called on selection changes and from the tick. Reads no network. */
  chatSync() {
    const view = this._chatViewEl();
    if (!view) return;
    const phone = this._chatIsPhone();
    const mode = this._chatMode();
    const root = document.documentElement;
    const id = this._chatDisplayId();
    const everLoaded = this._initGeneration > 0;
    const directorySize = Object.keys(this._chatDirectory()).length;
    this._chatRefreshDirectory();

    // Before the server answers there is no phone home to show, so show what is saved.
    const showHome = phone && mode === 'chat' && !everLoaded && !id && directorySize > 0;
    const showChat = mode === 'chat' && !showHome && !!id && this._chatSupported(id) && !this._tilesOwnTerminal?.();
    const home = showHome ? this._chatHomeEl() : document.getElementById('chatHome');
    if (home) home.hidden = !showHome;
    view.hidden = !showChat;
    root.dataset.chat = showHome ? 'home' : showChat ? 'session' : 'off';
    root.dataset.chatPhone = phone ? 'on' : 'off';
    this._chatTerminalPill(mode === 'terminal' && !!id && this._chatSupported(id) && !this._tilesOwnTerminal?.());
    if (showHome || showChat) this._chatBindViewport();
    // The offline overlay would hide a conversation that is perfectly readable.
    if ((showHome || showChat) && !this._offlineOverlayDismissed && !everLoaded) this.dismissOfflineOverlay?.();

    if (showHome) this._chatRenderHome();
    if (showChat) {
      if (phone && everLoaded) this._chatNoteHistory(id);
      if (this._chatShownId !== id) {
        this._chatShownId = id;
        this._chatRestoreDraft(id);
        // The saved copy first, so "Loading" never flashes over it. IndexedDB answers in
        // milliseconds, so the old session's rows just go.
        view.querySelector('.chat-log').replaceChildren();
        void this._chatHydrate(id).then(() => {
          if (this._chatShownId === id) this._chatRender(id, { toBottom: true });
        });
        this._chatKick();
      }
      this._chatRenderHead(id);
      this._chatRenderDock(id);
      this._chatRenderOutbox(id);
    } else if (this._chatShownId) {
      this._chatShownId = null;
    }
    this._chatRenderLink();
    this._chatPump();
    this._chatArm();
  },

  /** Phone: Back from a conversation goes home rather than out of the app. */
  _chatNoteHistory(id) {
    if (this._chatHistoryId === id && history.state?.chat === 'session') return;
    try {
      if (history.state?.chat === 'session') history.replaceState({ chat: 'session' }, '');
      else history.pushState({ chat: 'session' }, '');
    } catch {
      /* sandboxed */
    }
    this._chatHistoryId = id;
  },

  /** Terminal mode: a small floating button back to the chat view. */
  _chatTerminalPill(show) {
    let pill = document.getElementById('chatReturn');
    if (!show) {
      if (pill) pill.hidden = true;
      return;
    }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'chatReturn';
      pill.className = 'chat-return';
      pill.innerHTML = `${CHAT_ICONS.chat}<span>Chat</span>`;
      pill.addEventListener('click', () => this.setChatMode('chat'));
      document.body.appendChild(pill);
    }
    pill.hidden = false;
  },

  /**
   * The keyboard shrinks the visual viewport but not the layout viewport, so a fixed
   * full-screen view would leave its composer under the keyboard. The view takes the
   * visual viewport's size and place.
   */
  _chatBindViewport() {
    if (this._chatViewportBound) return;
    this._chatViewportBound = true;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      const scroller = document.querySelector('#chatView .chat-scroll');
      const atBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      root.style.setProperty('--chat-vh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--chat-vtop', `${Math.round(vv.offsetTop)}px`);
      root.classList.toggle('chat-keyboard', window.innerHeight - vv.height > 120);
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    apply();
  },

  // ── Link ────────────────────────────────────────────────────────────────
  _chatLinkState() {
    if (!this._chatLink) this._chatLink = { failures: 0, everOk: false, signedOut: false };
    return this._chatLink;
  },

  _chatStreamUp() {
    return this.eventSource?.readyState === 1;
  },

  _chatStatus(id) {
    const link = this._chatLinkState();
    return chatCore().linkStatus({
      online: navigator.onLine !== false,
      failures: link.failures,
      signedOut: link.signedOut,
      everOk: link.everOk || this._chatStreamUp(),
      updatedAt: id ? this._chat(id).updatedAt : 0,
      now: Date.now(),
    });
  },

  _chatRenderLink() {
    const id = this._chatShownId;
    const status = this._chatStatus(id);
    const signature = `${status.kind}|${status.text}|${status.detail}`;
    for (const el of document.querySelectorAll('.chat-link')) {
      if (el.dataset.sig === signature) continue;
      el.dataset.sig = signature;
      el.hidden = false;
      el.className = `chat-link is-${status.kind}`;
      el.replaceChildren();
      const dot = document.createElement('span');
      dot.className = 'chat-link-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'chat-link-text';
      text.textContent = status.text;
      el.append(dot, text);
      if (status.detail) {
        const detail = document.createElement('span');
        detail.className = 'chat-link-detail';
        detail.textContent = status.detail;
        el.appendChild(detail);
      }
      if (status.kind !== 'live') {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'chat-link-action';
        action.dataset.chat = status.kind === 'signin' ? 'signin' : 'retry';
        action.textContent = status.kind === 'signin' ? 'Sign in again' : 'Retry';
        el.appendChild(action);
      }
    }
  },

  _chatRetryNow() {
    for (const list of this._pendingDeliveries?.values() || []) for (const rec of list) rec.retryAt = 0;
    this._chatKick({ force: true });
  },

  /** Past the service worker to the real page, so the login redirect can happen. */
  _chatSignIn() {
    const url = window.CodemanBase?.url ? window.CodemanBase.url('/?signin=1') : '/?signin=1';
    location.assign(url);
  },

  // ── Data ────────────────────────────────────────────────────────────────
  /** One read. Resolves { kind, data } and never leaves a request running past its timeout. */
  async _chatFetch(id, params, timeoutKind, route = 'chat') {
    const link = this._chatLinkState();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), chatCore().requestTimeout(timeoutKind, link.failures));
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${route}?${new URLSearchParams(params)}`, {
        redirect: 'manual',
        signal: abort.signal,
        // Ahead of the page's other requests when a slow link has them queueing.
        priority: 'high',
      });
      const kind = chatCore().classifyResponse({
        type: res.type,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      });
      if (kind !== 'ok') return { kind };
      const json = await res.json();
      // The envelope's error is the machine not answering, not the link to this server.
      if (!json?.success) return { kind: 'retry', error: json?.error || 'Could not read the conversation' };
      return { kind: 'ok', data: json.data };
    } finally {
      clearTimeout(timer);
    }
  },

  /** Saved copy into memory, once per session per page load. True if there was one. */
  _chatHydrate(id) {
    const s = this._chat(id);
    if (!s.hydrating) {
      s.hydrating = this._chatCache()
        .load(id)
        .then((saved) => {
          if (!saved || s.log) return false;
          Object.assign(s, {
            log: saved.log,
            start: saved.start,
            end: saved.end,
            entries: saved.entries,
            loaded: true,
            fromCache: true,
            updatedAt: saved.updatedAt || 0,
          });
          const context = latestChatContext(s.entries);
          if (context) s.context = context;
          return true;
        })
        .catch(() => false);
    }
    return s.hydrating;
  },

  async _chatPoll(id) {
    const s = this._chat(id);
    if (s.busy) return;
    const link = this._chatLinkState();
    s.busy = true;
    try {
      await this._chatHydrate(id);
      const fresh = !s.log;
      const result = await this._chatFetch(id, fresh ? { after: -1 } : { after: s.end }, fresh ? 'tail' : 'delta');
      if (result.kind === 'signin') {
        link.signedOut = true;
      } else if (result.kind === 'gone') {
        link.signedOut = false;
        link.failures = 0;
        link.everOk = true;
        s.gone = true;
      } else if (result.kind !== 'ok') {
        link.failures++;
        link.signedOut = false;
        s.error = result.error || null;
      } else {
        if (link.failures > 0 || !link.everOk) link.confirmedAt = Date.now();
        link.failures = 0;
        link.everOk = true;
        link.signedOut = false;
        s.error = null;
        this._chatApply(id, result.data);
      }
    } catch {
      // A timeout or no network. The saved copy stays up and the status line says so.
      link.failures++;
    } finally {
      s.busy = false;
    }
    this._chatRenderLink();
    if (this._chatShownId === id) this._chatRenderDock(id);
    this._chatPump();
  },

  /** A good answer from the server: into memory, onto the saved copy, onto the screen. */
  _chatApply(id, data) {
    const s = this._chat(id);
    const core = chatCore();
    const now = Date.now();
    s.found = data.found;
    s.updatedAt = now;
    if (!data.found) {
      // No log yet, or the machine could not find it. A saved copy is still worth showing.
      s.loaded = true;
      if (this._chatShownId === id) this._chatRender(id);
      return;
    }
    const merge = core.mergeChunk(s.log ? { log: s.log, start: s.start, end: s.end } : null, data);
    const cache = this._chatCache();
    if (merge.action === 'reset') {
      Object.assign(s, { log: data.log, start: data.start, end: data.end, entries: data.entries, loaded: true });
      s.nodes.clear();
      s.visibleFrom = null;
      void cache.write(
        id,
        'reset',
        { log: data.log, start: data.start, end: data.end, entries: data.entries, updatedAt: now, forceChunk: true },
        now
      );
      if (this._chatShownId === id) this._chatRender(id, { toBottom: true });
    } else if (merge.action === 'append' || merge.action === 'touch') {
      const chunkStart = s.end;
      s.end = data.end;
      s.entries.push(...data.entries);
      s.loaded = true;
      void cache.write(
        id,
        merge.action,
        {
          log: s.log,
          start: s.start,
          end: s.end,
          chunkStart,
          chunkEnd: data.end,
          entries: data.entries,
          updatedAt: now,
          forceChunk: true,
        },
        now
      );
      s.savedAt = now;
      if (merge.action === 'append' && this._chatShownId === id) this._chatRender(id);
    } else if (now - (s.savedAt || 0) > 30_000) {
      // Nothing new, which is worth remembering for "updated N ago" after a reload.
      s.savedAt = now;
      void cache.write(id, 'none', { log: s.log, start: s.start, end: s.end, entries: [], updatedAt: now }, now);
    }
    if (merge.action === 'reset' || merge.action === 'append') {
      const context = latestChatContext(s.entries);
      if (context) s.context = context;
      this._chatReconcile(id, data.entries);
    } else {
      this._chatReconcile(id, []);
    }
  },

  async _chatLoadEarlier(id) {
    const s = this._chat(id);
    // Draw what is already here first; the network only when that runs out.
    if (s.visibleFrom > 0) {
      s.visibleFrom = Math.max(0, s.visibleFrom - CHAT_RENDER_WINDOW);
      this._chatRender(id, { keepFromBottom: true });
      return;
    }
    if (s.earlierBusy || !s.start || this._chatStatus(id).kind !== 'live') return;
    s.earlierBusy = true;
    try {
      const result = await this._chatFetch(id, { before: s.start }, 'earlier');
      if (result.kind !== 'ok') return;
      const merged = chatCore().mergeEarlier(s, result.data);
      if (!merged) return;
      const chunkEnd = s.start;
      s.start = merged.start;
      s.entries.unshift(...merged.entries);
      // Everything drawn stays put; the earlier rows join above it.
      s.keepAll = true;
      void this._chatCache().write(id, 'earlier', {
        log: s.log,
        start: s.start,
        end: s.end,
        chunkStart: merged.start,
        chunkEnd,
        entries: merged.entries,
        forceChunk: true,
      });
      this._chatRender(id, { keepFromBottom: true });
    } catch (err) {
      this.showToast?.(`Could not load earlier messages: ${err.message}`, 'error');
    } finally {
      s.earlierBusy = false;
    }
  },

  // ── Read loop ───────────────────────────────────────────────────────────
  /** The session worth reading: the one on screen, or the active one for the status bar. */
  _chatTarget() {
    const id = this._chatShownId || this.activeSessionId;
    return id && this._chatSupported(id) ? id : null;
  },

  /** (Re)start the timer for the next read, unless one is already due sooner. */
  _chatArm({ fresh = false } = {}) {
    const id = this._chatTarget();
    const core = chatCore();
    if (!id) {
      clearTimeout(this._chatTimer);
      this._chatTimer = null;
      return;
    }
    if (this._chatTimer && !fresh) return;
    const link = this._chatLinkState();
    const delay = core.nextPollDelay({
      hidden: document.hidden,
      online: navigator.onLine !== false,
      failures: link.failures,
      signedOut: link.signedOut,
      state: this._chatRowState(id)?.state || 'idle',
      sse: this._chatStreamUp(),
      background: !this._chatShownId,
    });
    clearTimeout(this._chatTimer);
    this._chatTimer = null;
    if (delay === null) return;
    this._chatTimer = setTimeout(() => {
      this._chatTimer = null;
      void this._chatReadNow();
    }, delay);
  },

  async _chatReadNow() {
    const id = this._chatTarget();
    if (!id) return;
    if (this._chatReading) {
      // Never two at once. Whatever asked gets a read straight after this one.
      this._chatReadAgain = true;
      return;
    }
    this._chatReading = true;
    this._chatLastReadAt = Date.now();
    try {
      await this._chatPoll(id);
    } finally {
      this._chatReading = false;
      if (this._chatReadAgain) {
        this._chatReadAgain = false;
        this._chatKick();
      } else this._chatArm({ fresh: true });
    }
  },

  /** Read soon: an event said the log grew, or the link or the screen just came back. */
  _chatKick({ force = false } = {}) {
    if (document.hidden && !force) return;
    if (this._chatKickTimer) return;
    // Several events arrive for one change, and a burst must not become a burst of reads.
    const since = Date.now() - (this._chatLastReadAt || 0);
    const wait = force ? 0 : Math.max(0, 800 - since);
    this._chatKickTimer = setTimeout(() => {
      this._chatKickTimer = null;
      void this._chatReadNow();
    }, wait);
  },

  // ── Outbox ──────────────────────────────────────────────────────────────
  _chatOutbox() {
    if (!this._chatOutboxData) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(CHAT_OUTBOX_KEY) || 'null');
      } catch {
        /* storage blocked, or a bad value */
      }
      this._chatOutboxData = Array.isArray(saved)
        ? saved.filter((e) => e && e.id && e.sessionId && typeof e.text === 'string')
        : [];
      // The input layer's own saved queue says how far each message got before the reload.
      for (const entry of this._chatOutboxData) {
        const rec = this._chatRecord(entry);
        if (entry.state === 'queued' && rec) {
          entry.state = 'sending';
          entry.handed = true;
        } else if (entry.state === 'sending' && !rec) {
          entry.state = 'sent';
          entry.sentAt = entry.sentAt || Date.now();
        }
      }
    }
    return this._chatOutboxData;
  },

  _chatSaveOutbox() {
    try {
      localStorage.setItem(CHAT_OUTBOX_KEY, JSON.stringify(this._chatOutbox()));
    } catch {
      /* storage blocked: messages last as long as the page */
    }
  },

  _chatRecord(entry) {
    return (this._pendingDeliveries?.get(entry.sessionId) || []).find((r) => r.tag === entry.id) || null;
  },

  _chatOutboxContext(id, status) {
    const s = this._chat(id);
    const row = this._chatRowState(id);
    const known = this._initGeneration > 0 ? !!this.sessions?.has(id) : undefined;
    const state = row ? (row.display === 'exited' ? 'exited' : row.state) : this._chatDirectory()[id]?.state || 'idle';
    // Just back: the session's state comes over the event stream, so give that a moment
    // to catch up before judging a held message by it. A stream that stays down (a proxy
    // that buffers it) must not hold messages for ever.
    const justBack = !this._chatStreamUp() && Date.now() - (this._chatLinkState().confirmedAt || 0) < 15_000;
    return {
      link: status.kind === 'live' && justBack ? 'reconnecting' : status.kind,
      now: Date.now(),
      sessionKnown: known,
      state,
      log: s.log || '',
      end: s.log ? s.end : undefined,
    };
  },

  /** Hand over whatever may go now. Runs after every read and every tick. */
  _chatPump() {
    const core = chatCore();
    const outbox = this._chatOutbox();
    if (!outbox.length) return;
    let changed = false;
    const bySession = new Map();
    for (const entry of [...outbox].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, []);
      bySession.get(entry.sessionId).push(entry);
    }
    for (const [id, entries] of bySession) {
      const ctx = this._chatOutboxContext(id, this._chatStatus(id));
      for (const entry of entries) {
        if (entry.state === 'sending') {
          const rec = this._chatRecord(entry);
          if (!rec) {
            entry.state = 'sent';
            entry.sentAt = Date.now();
            changed = true;
          } else if (core.recordHeld(rec, ctx.now)) {
            entry.state = 'hold';
            entry.reason = 'Not confirmed after 5 minutes. It may have arrived; check above before sending again.';
            changed = true;
          }
          if (entry.state !== 'sent') break; // Nothing overtakes a message still on its way.
        }
        if (entry.state === 'sent' || entry.state === 'failed') continue;
        if (entry.state === 'hold' && entry.handed) break;
        if (entry.notBefore && ctx.now < entry.notBefore) break;
        const decision = core.decideOutbox(entry, ctx);
        if (decision.action === 'send') {
          this._chatHandOver(entry);
          changed = true;
          break; // One at a time, so a refused message stops the ones behind it.
        }
        if (decision.action === 'fail') {
          entry.state = 'failed';
          entry.reason = decision.reason;
          changed = true;
          continue;
        }
        if (decision.action === 'hold') {
          if (entry.state !== 'hold' || entry.reason !== decision.reason) changed = true;
          entry.state = 'hold';
          entry.reason = decision.reason;
          entry.blocked = !!decision.blocked;
          break;
        }
        if (entry.state === 'hold' && entry.blocked) {
          entry.blocked = false;
          entry.reason = 'Claude has moved on from that. Tap Send if you still want this sent.';
          changed = true;
        }
        break; // Waiting: the ones behind it wait too, so the order holds.
      }
    }
    if (changed) this._chatOutboxChanged();
  },

  /** The one way a chat message leaves: the exactly-once input layer, as one record. */
  _chatHandOver(entry) {
    // Another tab may have sent it. localStorage is synchronous, so read it right here.
    try {
      const stored = JSON.parse(localStorage.getItem(CHAT_OUTBOX_KEY) || '[]').find((e) => e.id === entry.id);
      if (!stored || stored.state === 'sending' || stored.state === 'sent') {
        this._chatOutboxData = null;
        return;
      }
    } catch {
      /* storage blocked: there is no other tab's copy to read */
    }
    // One frame, one seq, one ACK: the server pastes the text and presses Enter itself
    // (POST + useMux), and a line break stays inside the paste.
    const data = `${entry.text.replace(/\r\n?/g, '\n')}\r`;
    entry.state = 'sending';
    entry.handed = true;
    entry.approved = false;
    entry.reason = '';
    entry.sentAt = Date.now();
    this._reliableSend(entry.sessionId, data, true, { post: true, tag: entry.id });
    // In that order: a crash between the two leaves `queued` plus a tagged record, which
    // the next load reads as sending. The other order could read as sent and lose it.
    this._chatSaveOutbox();
    setTimeout(() => this._chatKick(), 900);
  },

  /** Called by the input layer when a tagged record is done with. */
  _chatInputSettled(sessionId, rec) {
    const entry = this._chatOutbox().find((e) => e.id === rec.tag);
    if (!entry) return;
    if (rec.outcome === 'rejected') {
      entry.state = 'failed';
      entry.handed = false;
      entry.reason = 'The server refused this message. It was not sent.';
    } else if (rec.outcome === 'gone') {
      entry.state = 'failed';
      entry.handed = false;
      entry.reason = 'This session has ended.';
    } else {
      entry.state = 'sent';
      entry.sentAt = Date.now();
      this._chatKick();
    }
    this._chatOutboxChanged();
  },

  _chatReconcile(id, newEntries) {
    const outbox = this._chatOutbox();
    const mine = outbox.filter((e) => e.sessionId === id);
    if (!mine.length) return;
    const { seen, forgotten } = chatCore().reconcileOutbox(mine, newEntries, Date.now());
    if (!seen.length && !forgotten.length) return;
    const gone = new Set([...seen, ...forgotten]);
    this._chatOutboxData = outbox.filter((e) => !gone.has(e.id));
    this._chatOutboxChanged();
  },

  _chatOutboxChanged() {
    this._chatSaveOutbox();
    if (this._chatShownId) this._chatRenderOutbox(this._chatShownId);
  },

  _chatRemoveOutbox(entry) {
    // A copy already handed over (a message held after 5 minutes) must not go out later.
    const list = this._pendingDeliveries?.get(entry.sessionId);
    const rec = list && list.find((r) => r.tag === entry.id);
    if (rec) {
      list.splice(list.indexOf(rec), 1);
      if (!list.length) this._pendingDeliveries.delete(entry.sessionId);
      this._persistReliableNow?.();
    }
    this._chatOutboxData = this._chatOutbox().filter((e) => e.id !== entry.id);
    this._chatOutboxChanged();
  },

  /** The tap a held message waits for. */
  _chatOutboxSend(entry) {
    const rec = this._chatRecord(entry);
    if (rec) {
      // Same seq if nothing was sent after it, so a copy that did land is not typed twice.
      // A later seq would make this one a "duplicate" the server drops, so it needs a new one.
      if (this._seqCounters.get(entry.sessionId) !== rec.seq) rec.seq = this._nextSeq(entry.sessionId);
      rec.approved = true;
      rec.ts = Date.now();
      rec.retryAt = 0;
      entry.state = 'sending';
      entry.reason = '';
      this._persistReliableNow?.();
      this._drainSession(entry.sessionId);
    } else {
      entry.state = 'queued';
      entry.approved = true;
      entry.reason = '';
      entry.createdAt = Date.now();
    }
    this._chatOutboxChanged();
    this._chatPump();
  },

  _chatRenderOutbox(id) {
    const view = this._chatViewEl();
    const box = view?.querySelector('.chat-outbox');
    if (!box) return;
    const core = chatCore();
    const entries = this._chatOutbox().filter((e) => e.sessionId === id);
    const signature = JSON.stringify(entries.map((e) => [e.id, e.state, e.reason, e.blocked, e.handed]));
    if (box.dataset.sig === signature) return;
    const scroller = view.querySelector('.chat-scroll');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    box.dataset.sig = signature;
    box.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `chat-msg chat-user chat-outgoing is-${entry.state}`;
      row.dataset.ob = entry.id;
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';
      const split = chatSplitUploads(entry.text);
      bubble.textContent = split.text;
      if (split.uploads.length) row.appendChild(this._chatUploadStrip(id, split.uploads));
      const meta = document.createElement('div');
      meta.className = 'chat-outgoing-meta';
      const label = document.createElement('span');
      label.className = 'chat-outgoing-label';
      label.textContent = core.outboxLabel(entry);
      meta.appendChild(label);
      const button = (text, action) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chat-outgoing-action';
        b.dataset.chat = action;
        b.dataset.ob = entry.id;
        b.textContent = text;
        meta.appendChild(b);
      };
      if (entry.state === 'queued') {
        button('Edit', 'ob-edit');
        button('Cancel', 'ob-cancel');
      } else if (entry.state === 'hold' || entry.state === 'failed') {
        if (!entry.blocked && entry.state === 'hold') button('Send', 'ob-send');
        button('Edit', 'ob-edit');
        button('Discard', 'ob-cancel');
      }
      if (split.text) row.appendChild(bubble);
      row.appendChild(meta);
      box.appendChild(row);
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  },

  // ── Rendering ───────────────────────────────────────────────────────────
  _chatRowState(id) {
    const rows = typeof this.buildHomeSessionRows === 'function' ? this.buildHomeSessionRows() : [];
    return rows.find((r) => r.id === id) || null;
  },

  _chatRenderHead(id) {
    const view = this._chatViewEl();
    if (!view) return;
    const session = this.sessions?.get(id);
    // Nothing from the server yet: as the page last knew it.
    const saved = this._chatDirectory()[id];
    if (!session && !saved) return;
    const row = session ? this._chatRowState(id) : null;
    view.querySelector('.chat-title').textContent = row?.name || session?.name || saved?.name || id.slice(0, 8);
    const where = session
      ? session.remote
        ? session.remote.label || session.remote.hostId
        : 'This server'
      : saved.where;
    const folder = chatBasename(session ? session.remote?.remotePath || session.workingDir || '' : saved.folder);
    view.querySelector('.chat-subtitle').textContent = [where, folder].filter(Boolean).join(' · ');
    view.querySelector('.chat-spinner').classList.toggle('on', row?.state === 'working');
    view.querySelector('[data-chat="mode-chat"]').setAttribute('aria-pressed', 'true');
    const model = session?.displayModel?.model || session?.model || saved?.model || '';
    view.querySelector('.chat-model').textContent = model ? chatOneLine(String(model).replace(/^claude-/, ''), 28) : '';
  },

  _chatRender(id, { toBottom = false, keepFromBottom = false } = {}) {
    const view = this._chatViewEl();
    if (!view) return;
    const s = this._chat(id);
    const scroller = view.querySelector('.chat-scroll');
    const log = view.querySelector('.chat-log');
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    const scrollTop = scroller.scrollTop;

    const items = buildChatItems(s.entries);
    this._chatItems = items;
    if (s.keepAll) {
      s.visibleFrom = 0;
      s.keepAll = false;
    } else if (s.visibleFrom === null && items.length) {
      s.visibleFrom = Math.max(0, items.length - CHAT_RENDER_WINDOW);
    }
    const frag = document.createDocumentFragment();
    if (s.start > 0 || s.visibleFrom > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chat-earlier';
      more.dataset.chat = 'earlier';
      more.textContent = 'Load earlier messages';
      frag.appendChild(more);
    }
    if (!s.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      const status = this._chatStatus(id).kind;
      if (s.loaded && !s.found) {
        empty.innerHTML =
          '<p>No messages yet.</p><p class="chat-empty-hint">Send a message below, or open the terminal if Claude is still starting.</p>';
      } else if (status === 'offline' || status === 'signin') {
        empty.textContent = 'Nothing is saved on this device for this conversation yet.';
      } else {
        empty.textContent = 'Loading conversation…';
      }
      frag.appendChild(empty);
    }
    // Moving a row resets the sideways scroll of what is inside it.
    const sideways = [...log.querySelectorAll('.chat-table-wrap, pre')]
      .filter((n) => n.scrollLeft > 0)
      .map((n) => [n, n.scrollLeft]);
    // Rows are kept between renders: a markdown render is the slow part on a phone, and
    // a log row does not change unless its signature does.
    const kept = new Map();
    for (let i = s.visibleFrom || 0; i < items.length; i++) {
      const item = items[i];
      const sig = chatItemSignature(item);
      let cached = s.nodes.get(item.key);
      if (!cached || cached.sig !== sig) {
        const node = this._chatRenderItem(id, item);
        const open = cached?.node?.dataset.open === '1';
        if (node && open) node.dataset.open = '1';
        cached = node ? { sig, node } : null;
      }
      if (!cached) continue;
      kept.set(item.key, cached);
      frag.appendChild(cached.node);
    }
    s.nodes = kept;
    log.replaceChildren(frag);
    for (const [n, left] of sideways) n.scrollLeft = left;
    if (toBottom || nearBottom) scroller.scrollTop = scroller.scrollHeight;
    else if (keepFromBottom) scroller.scrollTop = scroller.scrollHeight - fromBottom;
    else scroller.scrollTop = scrollTop;
    this._chatRenderDock(id);
    this._chatRenderOutbox(id);
    this._chatRenderPins(id);
  },

  _chatRenderItem(id, item) {
    const el = document.createElement('div');
    el.dataset.key = item.key;
    switch (item.kind) {
      case 'user': {
        el.className = `chat-msg chat-user${item.command ? ' chat-user--command' : ''}`;
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        if (item.images?.length) {
          const strip = document.createElement('div');
          strip.className = 'chat-images';
          const log = this._chat(id).log || '';
          for (const img of item.images) {
            const a = document.createElement('a');
            const path = `/api/sessions/${encodeURIComponent(id)}/chat/image?log=${encodeURIComponent(log)}&at=${img.at}&len=${img.len}&n=${img.n || 0}`;
            // A src attribute goes round the fetch wrapper that adds a sub-path mount.
            const src = window.CodemanBase?.url ? window.CodemanBase.url(path) : path;
            a.href = src;
            a.target = '_blank';
            a.rel = 'noopener';
            a.className = 'chat-image';
            const image = document.createElement('img');
            image.src = src;
            image.alt = 'Pasted image';
            image.loading = 'lazy';
            image.decoding = 'async';
            // Offline with no saved copy: a quiet placeholder, never a broken-image icon.
            image.addEventListener('error', () => a.classList.add('is-missing'));
            a.appendChild(image);
            strip.appendChild(a);
          }
          el.appendChild(strip);
        }
        const split = chatSplitUploads(item.text);
        if (split.uploads.length) el.appendChild(this._chatUploadStrip(id, split.uploads));
        if (split.text) {
          bubble.textContent = split.text;
          el.appendChild(bubble);
        }
        if (item.queued) {
          const q = document.createElement('div');
          q.className = 'chat-bubble-meta';
          q.textContent = 'Sent while Claude was working';
          el.appendChild(q);
        }
        return el;
      }
      case 'text': {
        el.className = 'chat-msg chat-assistant rv-text';
        el.innerHTML = this._renderMarkdown ? this._renderMarkdown(item.text) : chatEsc(item.text);
        // A wide table scrolls by itself; the page beside it stays put.
        el.querySelectorAll('table').forEach((table) => {
          const wrap = document.createElement('div');
          wrap.className = 'chat-table-wrap';
          table.replaceWith(wrap);
          wrap.appendChild(table);
        });
        el.querySelectorAll('a.rv-path').forEach((a) => (a.dataset.sessionId = id));
        this._linkifyFilePaths?.(el);
        el.querySelectorAll('a.rv-path').forEach((a) => (a.dataset.sessionId = id));
        return el;
      }
      case 'thinking': {
        el.className = 'chat-fold chat-thinking';
        el.innerHTML = `<button type="button" class="chat-fold-head" data-chat="fold"><span>Thought</span>${CHAT_ICONS.chevron}</button><div class="chat-fold-body"><div class="chat-thinking-text"></div></div>`;
        el.querySelector('.chat-thinking-text').textContent = item.text;
        return el;
      }
      case 'activity': {
        const running = item.tools.some((t) => !t.result);
        el.className = `chat-fold chat-activity${running ? ' is-running' : ''}`;
        const errors = item.tools.filter((t) => t.result?.isError).length;
        el.innerHTML = `<button type="button" class="chat-fold-head" data-chat="fold"><span class="chat-activity-label"></span>${errors ? `<span class="chat-badge chat-badge--err">${errors} failed</span>` : ''}${CHAT_ICONS.chevron}</button><div class="chat-fold-body"><ol class="chat-tools"></ol></div>`;
        el.querySelector('.chat-activity-label').textContent =
          item.tools.length === 1
            ? chatToolTitle(item.tools[0].name, item.tools[0].input)
            : chatActivitySummary(item.tools);
        const list = el.querySelector('.chat-tools');
        for (const tool of item.tools) list.appendChild(this._chatRenderTool(tool, item.key));
        return el;
      }
      case 'file':
        return this._chatRenderFileCard(id, item, el);
      case 'question':
        return this._chatRenderQuestion(item, el);
      case 'todo': {
        const todos = Array.isArray(item.tool.input?.todos) ? item.tool.input.todos : [];
        el.className = 'chat-card chat-todo';
        const head = document.createElement('div');
        head.className = 'chat-card-eyebrow';
        head.textContent = 'Plan';
        el.appendChild(head);
        const ul = document.createElement('ul');
        for (const t of todos) {
          const li = document.createElement('li');
          li.className = `chat-todo-item is-${t.status || 'pending'}`;
          li.textContent = t.status === 'in_progress' ? t.activeForm || t.content : t.content;
          ul.appendChild(li);
        }
        el.appendChild(ul);
        return el;
      }
      case 'agent': {
        const input = item.tool.input || {};
        el.className = `chat-file-card chat-agent-card${item.tool.result ? '' : ' is-running'}`;
        el.dataset.chat = 'open-agent';
        el.dataset.tool = item.tool.id;
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
        el.innerHTML = `<span class="chat-file-icon">${CHAT_ICONS.agent}</span><span class="chat-file-text"><span class="chat-file-name"></span><span class="chat-file-detail"></span></span>${CHAT_ICONS.chevron}`;
        const title = input.description || chatOneLine(input.prompt, 70) || 'Agent';
        el.dataset.title = title;
        el.querySelector('.chat-file-name').textContent = title;
        el.querySelector('.chat-file-detail').textContent = [
          'Agent',
          input.subagent_type && input.subagent_type !== 'general-purpose' ? input.subagent_type : '',
          item.tool.result?.isError ? 'failed' : item.tool.result ? '' : 'starting',
        ]
          .filter(Boolean)
          .join(' · ');
        return el;
      }
      case 'artifact': {
        const a = document.createElement('a');
        a.className = 'chat-file-card chat-artifact-card';
        a.dataset.key = item.key;
        a.href = item.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerHTML = `<span class="chat-file-icon">${CHAT_ICONS.artifact}</span><span class="chat-file-text"><span class="chat-file-name"></span><span class="chat-file-detail">Artifact</span></span>${CHAT_ICONS.chevron}`;
        a.querySelector('.chat-file-name').textContent =
          item.tool.result?.title || item.tool.input?.title || chatBasename(item.tool.input?.file_path) || 'Open page';
        return a;
      }
      case 'note': {
        el.className = 'chat-note';
        el.textContent = item.text;
        return el;
      }
      case 'compact':
      case 'output': {
        el.className = `chat-fold chat-${item.kind}`;
        el.innerHTML = `<button type="button" class="chat-fold-head" data-chat="fold"><span class="chat-fold-label"></span>${CHAT_ICONS.chevron}</button><div class="chat-fold-body"><div class="chat-output-text"></div></div>`;
        el.querySelector('.chat-fold-label').textContent =
          item.kind === 'output'
            ? item.title
            : item.before && item.after
              ? `Conversation compacted · ${chatTokens(item.before)} → ${chatTokens(item.after)} tokens`
              : 'Conversation compacted';
        const body = el.querySelector('.chat-output-text');
        if (item.text) body.textContent = item.text;
        else el.querySelector('.chat-fold-head').disabled = true;
        return el;
      }
      default:
        return null;
    }
  },

  /** Pictures from their upload paths, read through the session's own file route. */
  _chatUploadStrip(id, paths) {
    const strip = document.createElement('div');
    strip.className = 'chat-images';
    for (const path of paths) {
      const route = `/api/sessions/${encodeURIComponent(id)}/file-raw?path=${encodeURIComponent(path)}`;
      const src = window.CodemanBase?.url ? window.CodemanBase.url(route) : route;
      const a = document.createElement('a');
      a.href = src;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'chat-image';
      const image = document.createElement('img');
      image.src = src;
      image.alt = chatBasename(path);
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => a.classList.add('is-missing'));
      a.appendChild(image);
      strip.appendChild(a);
    }
    return strip;
  },

  /** Artifacts this conversation touched, kept in reach above the log. */
  _chatRenderPins(id) {
    const view = this._chatViewEl();
    const box = view?.querySelector('.chat-pins');
    if (!box) return;
    const pins = chatArtifacts(this._chatItems || []);
    const sig = JSON.stringify([id, pins]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.hidden = !pins.length;
    box.replaceChildren(
      ...pins.map((pin) => {
        const a = document.createElement('a');
        a.className = 'chat-pin';
        a.href = pin.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerHTML = CHAT_ICONS.artifact;
        a.append(chatOneLine(pin.title || 'Artifact', 40));
        return a;
      })
    );
  },

  // ── A subagent's own log ────────────────────────────────────────────────
  chatOpenAgent(id, tool, title) {
    const view = this._chatViewEl();
    const sheet = view?.querySelector('.chat-agent-sheet');
    if (!sheet || !tool) return;
    this._chatAgentOpen = { id, tool };
    sheet.hidden = false;
    sheet.querySelector('.chat-agent-title').textContent = title || 'Agent';
    const log = sheet.querySelector('.chat-agent-log');
    log.dataset.sig = '';
    log.replaceChildren();
    const wait = document.createElement('div');
    wait.className = 'chat-empty';
    wait.textContent = 'Loading agent…';
    log.appendChild(wait);
    void this._chatPollAgent();
  },

  chatCloseAgent() {
    this._chatAgentOpen = null;
    clearTimeout(this._chatAgentTimer);
    const sheet = this._chatViewEl()?.querySelector('.chat-agent-sheet');
    if (sheet) sheet.hidden = true;
  },

  async _chatPollAgent() {
    const open = this._chatAgentOpen;
    if (!open) return;
    clearTimeout(this._chatAgentTimer);
    let data = null;
    try {
      const got = await this._chatFetch(open.id, { tool: open.tool }, 'read', 'chat/agent');
      if (got.kind === 'ok') data = got.data;
    } catch {
      /* The next read tries again; what is on screen stays. */
    }
    if (this._chatAgentOpen !== open) return;
    if (data) this._chatRenderAgent(open, data);
    this._chatAgentTimer = setTimeout(() => this._chatPollAgent(), 4000);
  },

  _chatRenderAgent(open, data) {
    const sheet = this._chatViewEl().querySelector('.chat-agent-sheet');
    const log = sheet.querySelector('.chat-agent-log');
    const scroller = sheet.querySelector('.chat-agent-scroll');
    const entries = (data.entries || []).map((e) => ({ ...e, sidechain: false }));
    const sig = `${data.found}:${entries.length}:${entries.at(-1)?.uuid || ''}`;
    if (log.dataset.sig === sig) return;
    log.dataset.sig = sig;
    const atBottom = !log.childElementCount || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    const open_ = new Set([...log.querySelectorAll('[data-open="1"]')].map((n) => n.dataset.key));
    const nodes = buildChatItems(entries)
      .map((item) => {
        const node = this._chatRenderItem(open.id, item);
        if (node && open_.has(item.key)) node.dataset.open = '1';
        return node;
      })
      .filter(Boolean);
    if (!nodes.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = data.found ? 'Nothing from this agent yet.' : 'This agent has no log on that machine.';
      nodes.push(empty);
    }
    log.replaceChildren(...nodes);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  },

  // ── The / picker ────────────────────────────────────────────────────────
  _chatSlashSkills(id) {
    const s = this._chat(id);
    if (s.skillsLog === (s.log || '') && s.skills) return s.skills;
    if (!s.skillsLoading) {
      s.skillsLoading = true;
      this._chatFetch(id, {}, 'read', 'chat/skills')
        .then((got) => {
          if (got.kind !== 'ok') return;
          s.skills = got.data.skills || [];
          s.skillsLog = s.log || '';
          this._chatRenderSlash();
        })
        .catch(() => {})
        .finally(() => {
          s.skillsLoading = false;
        });
    }
    return s.skills || [];
  },

  _chatRenderSlash() {
    const view = this._chatViewEl();
    const box = view?.querySelector('.chat-slash');
    const id = this._chatShownId;
    if (!box || !id) return;
    const typed = view.querySelector('.chat-input').innerText.replace(/\n+$/, '');
    const rows = /^\/[^\s/]*$/.test(typed) ? chatSlashMatches(typed, this._chatSlashSkills(id)) : null;
    this._chatSlashRows = rows || [];
    if (!rows?.length) {
      box.hidden = true;
      box.replaceChildren();
      this._chatSlashAt = 0;
      return;
    }
    this._chatSlashAt = Math.min(this._chatSlashAt || 0, rows.length - 1);
    box.hidden = false;
    box.replaceChildren(
      ...rows.map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `chat-slash-row${i === this._chatSlashAt ? ' is-on' : ''}`;
        b.dataset.chat = 'slash';
        b.dataset.name = c.name;
        const name = document.createElement('span');
        name.className = 'chat-slash-name';
        name.textContent = `/${c.name}`;
        const desc = document.createElement('span');
        desc.className = 'chat-slash-desc';
        desc.textContent = c.menu ? `${c.description} (opens the terminal)` : c.description;
        b.append(name, desc);
        return b;
      })
    );
  },

  _chatSlashPick(name) {
    const view = this._chatViewEl();
    const input = view.querySelector('.chat-input');
    input.textContent = `/${name} `;
    input.focus();
    document.getSelection()?.selectAllChildren(input);
    document.getSelection()?.collapseToEnd();
    if (this._chatShownId) {
      this._chat(this._chatShownId).draft = input.textContent;
      this._chatRenderDock(this._chatShownId);
    }
    this._chatRenderSlash();
  },

  _chatRenderTool(tool, groupKey) {
    const li = document.createElement('li');
    li.className = `chat-tool${tool.result ? '' : ' is-running'}${tool.result?.isError ? ' is-error' : ''}`;
    li.dataset.key = `${groupKey}:${tool.id}`;
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'chat-tool-head';
    head.dataset.chat = 'fold';
    const name = document.createElement('span');
    name.className = 'chat-tool-name';
    name.textContent = tool.name.startsWith('mcp__') ? 'MCP' : tool.name;
    const title = document.createElement('span');
    title.className = 'chat-tool-title';
    title.textContent = chatToolTitle(tool.name, tool.input);
    head.append(name, title);
    li.appendChild(head);
    const body = document.createElement('div');
    body.className = 'chat-fold-body';
    const input = tool.input || {};
    const shown =
      tool.name === 'Bash'
        ? input.command
        : tool.name === 'Task' || tool.name === 'Agent'
          ? input.prompt
          : input.file_path && Object.keys(input).length <= 3
            ? input.file_path
            : JSON.stringify(input, null, 2);
    if (shown) body.appendChild(this._chatPre(String(shown), 'chat-pre--input'));
    if (tool.result?.text)
      body.appendChild(this._chatPre(tool.result.text, tool.result.isError ? 'chat-pre--error' : ''));
    else if (!tool.result) {
      const wait = document.createElement('div');
      wait.className = 'chat-tool-wait';
      wait.textContent = 'Running…';
      body.appendChild(wait);
    }
    li.appendChild(body);
    return li;
  },

  _chatPre(text, cls) {
    const box = document.createElement('div');
    box.className = `chat-pre ${cls || ''}`.trim();
    const pre = document.createElement('pre');
    pre.textContent = text;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chat-copy';
    copy.dataset.chat = 'copy';
    copy.setAttribute('aria-label', 'Copy');
    copy.innerHTML = CHAT_ICONS.copy;
    box.append(pre, copy);
    return box;
  },

  _chatRenderFileCard(id, item, el) {
    const input = item.tool.input || {};
    const path = String(input.file_path || input.notebook_path || '');
    el.className = 'chat-file-card';
    el.dataset.chat = 'open-file';
    el.dataset.path = path;
    el.dataset.session = '';
    el.dataset.sessionId = id;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    let detail = '';
    if (item.tool.name === 'Write') {
      const content = String(input.content || '');
      // The server cuts long strings, so only an uncut file has a true line count.
      const lines = content.split('\n').length;
      detail = /\n… \([\d,]+ more characters\)$/.test(content)
        ? 'Created'
        : `Created · ${lines} line${lines === 1 ? '' : 's'}`;
    } else {
      const edits = item.tool.name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [input];
      let add = 0;
      let del = 0;
      for (const e of edits) {
        add += String(e.new_string ?? e.new_source ?? '').split('\n').length;
        del += String(e.old_string ?? '').split('\n').length;
      }
      detail = `<span class="chat-add">+${add}</span> <span class="chat-del">−${del}</span>`;
    }
    const failed = item.tool.result?.isError;
    el.innerHTML = `<span class="chat-file-icon">${CHAT_ICONS.file}</span><span class="chat-file-text"><span class="chat-file-name"></span><span class="chat-file-detail">${failed ? 'Edit failed' : detail}</span></span>${CHAT_ICONS.chevron}`;
    el.querySelector('.chat-file-name').textContent = chatBasename(path);
    el.title = path;
    return el;
  },

  _chatRenderQuestion(item, el) {
    const questions = Array.isArray(item.tool.input?.questions) ? item.tool.input.questions : [];
    const answered = !!item.tool.result;
    el.className = `chat-card chat-question${answered ? ' is-answered' : ''}`;
    const eyebrow = document.createElement('div');
    eyebrow.className = 'chat-card-eyebrow';
    eyebrow.textContent = questions.length > 1 ? 'Questions' : 'Question';
    el.appendChild(eyebrow);
    const answers = answered ? String(item.tool.result.text || '') : '';
    for (const q of questions) {
      const block = document.createElement('div');
      block.className = 'chat-q';
      const qt = document.createElement('div');
      qt.className = 'chat-q-text';
      qt.textContent = q.question || q.header || '';
      block.appendChild(qt);
      if (answered) {
        const m = answers.match(
          new RegExp(`"${String(q.question || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"="([^"]*)"`)
        );
        const a = document.createElement('div');
        a.className = 'chat-q-answer';
        a.textContent = m ? m[1] : '';
        if (a.textContent) block.appendChild(a);
      } else {
        const opts = document.createElement('ul');
        opts.className = 'chat-q-options';
        for (const o of q.options || []) {
          const li = document.createElement('li');
          li.textContent = o.label;
          if (o.description) {
            const d = document.createElement('span');
            d.textContent = o.description;
            li.appendChild(d);
          }
          opts.appendChild(li);
        }
        block.appendChild(opts);
      }
      el.appendChild(block);
    }
    return el;
  },

  // ── Prompt card, status line, composer state ────────────────────────────
  _chatPendingQuestion() {
    const items = this._chatItems || [];
    for (let i = items.length - 1; i >= 0 && i >= items.length - 6; i--) {
      if (items[i].kind === 'question' && !items[i].tool.result) return items[i];
    }
    return null;
  },

  _chatPendingTool() {
    const items = this._chatItems || [];
    for (let i = items.length - 1; i >= 0 && i >= items.length - 3; i--) {
      const it = items[i];
      if (it.kind === 'activity') {
        const t = it.tools[it.tools.length - 1];
        return t && !t.result ? t : null;
      }
      if (it.kind === 'file') return it.tool.result ? null : it.tool;
      if (it.kind === 'text' || it.kind === 'user') return null;
    }
    return null;
  },

  _chatRenderDock(id) {
    const view = this._chatViewEl();
    if (!view || this._chatShownId !== id) return;
    const row = this._chatRowState(id);
    const state = row?.state || 'idle';
    const working = state === 'working';
    const prompt = view.querySelector('.chat-prompt');
    const status = view.querySelector('.chat-status');
    const s = this._chat(id);
    const link = this._chatStatus(id).kind;
    const live = link === 'live';

    // A dialog waiting on you. The list re-reads the pane on the server each time.
    if (state === 'needs' && live && Date.now() - (s.approvalAt || 0) > 4000) void this._chatRefreshApproval(id);
    if (state !== 'needs') {
      s.approval = null;
      s.approvalLoaded = false;
      s.answerError = '';
      s.answering = null;
    }
    const question = this._chatPendingQuestion();
    const signature =
      state === 'needs'
        ? JSON.stringify([
            s.approval?.id,
            s.approval?.options,
            s.approvalLoaded,
            question?.key,
            link,
            s.answering,
            s.answerError,
          ])
        : '';
    if (signature !== this._chatPromptSig) {
      this._chatPromptSig = signature;
      prompt.replaceChildren();
      if (state === 'needs') {
        prompt.hidden = false;
        prompt.appendChild(this._chatPromptCard(id, s.approval, question, link));
      } else prompt.hidden = true;
    }

    const bits = [];
    if (s.error) bits.push(`<span class="chat-status-err">${chatEsc(s.error)}</span>`);
    else if (working) {
      const doing = chatRunningLabel(this._chatItems || []);
      const detail = [doing, row?.watching].filter(Boolean).map((t) => ` · ${chatEsc(chatOneLine(t, 80))}`);
      bits.push(
        `<span class="chat-working"><span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Working…${detail.join('')}</span>`
      );
    } else if (row?.display === 'exited') bits.push('<span>Claude exited in this session.</span>');
    status.hidden = !bits.length;
    const statusHtml = bits.join('');
    if (status.dataset.sig !== statusHtml) {
      status.dataset.sig = statusHtml;
      status.innerHTML = statusHtml;
    }

    const hasText = !!this._chatInputText(view) || s.uploads.some((u) => u.path);
    const send = view.querySelector('.chat-send');
    // Stopping is a key press, so like an answer it never waits for a link.
    const stopMode = working && !hasText;
    send.classList.toggle('is-stop', stopMode);
    const sendMode = stopMode ? 'stop' : 'send';
    if (send.dataset.mode !== sendMode) {
      send.dataset.mode = sendMode;
      send.innerHTML = stopMode ? CHAT_ICONS.stop : CHAT_ICONS.send;
    }
    send.setAttribute('aria-label', stopMode ? 'Stop Claude' : working ? 'Queue message' : 'Send');
    send.title = stopMode
      ? live
        ? 'Stop'
        : 'Stop needs a connection'
      : working
        ? 'Send when Claude finishes this step'
        : 'Send';
    send.disabled = stopMode ? !live : !hasText;
    view.querySelector('.chat-sendnow').hidden = !(working && hasText && live);
    view.querySelector('.chat-attach').disabled = !live;
    view.querySelector('.chat-attach').title = live ? 'Attach' : 'Attachments need a connection';

    const chip = view.querySelector('.chat-context');
    const ctx = s.context;
    chip.hidden = !ctx;
    if (ctx) {
      const pct = Math.min(100, Math.round((ctx.used / ctx.limit) * 100));
      const sig = `${ctx.used}/${ctx.limit}`;
      if (chip.dataset.sig !== sig) {
        chip.dataset.sig = sig;
        chip.className = `chat-context${pct >= 80 ? ' is-high' : pct >= 60 ? ' is-mid' : ''}`;
        chip.style.setProperty('--p', String(pct));
        chip.innerHTML =
          '<span class="chat-context-ring" aria-hidden="true"></span><span class="chat-context-pct"></span>';
        chip.querySelector('.chat-context-pct').textContent = `${pct}%`;
        chip.title = `Context: ${chatTokens(ctx.used)} of ${chatTokens(ctx.limit)} tokens`;
        chip.setAttribute('aria-label', chip.title);
      }
    }
  },

  /** The dialog on the live screen, per the server. Null means none it could read. */
  async _chatRefreshApproval(id) {
    const s = this._chat(id);
    if (s.approvalBusy) return;
    s.approvalBusy = true;
    s.approvalAt = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const res = await fetch('/api/approvals', { redirect: 'manual', signal: abort.signal });
      const kind = chatCore().classifyResponse({
        type: res.type,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      });
      if (kind === 'signin') this._chatLinkState().signedOut = true;
      if (kind === 'ok') {
        const json = await res.json();
        const items = Array.isArray(json?.data?.approvals) ? json.data.approvals : [];
        s.approval = items.find((a) => a.sessionId === id && a.kind !== 'idle') || null;
        s.approvalLoaded = true;
      }
    } catch {
      /* The status line reports the link. The card stays as it is, disabled if the link is down. */
    } finally {
      clearTimeout(timer);
      s.approvalBusy = false;
    }
    if (this._chatShownId === id) this._chatRenderDock(id);
  },

  /** One key, checked against the live pane on the server, sent once or not at all. */
  async _chatAnswer(id, optionNumber) {
    const s = this._chat(id);
    const item = s.approval;
    if (!item || s.answering || this._chatStatus(id).kind !== 'live') return;
    s.answering = optionNumber;
    s.answerError = '';
    this._chatRenderDock(id);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(item.id)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'option', option: optionNumber }),
        redirect: 'manual',
        signal: abort.signal,
      });
      const kind = chatCore().classifyResponse({
        type: res.type,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
      });
      if (kind === 'signin') {
        this._chatLinkState().signedOut = true;
        s.answerError = 'You are signed out. Nothing was pressed.';
      } else {
        const json = kind === 'ok' || kind === 'gone' ? await res.json().catch(() => null) : null;
        if (json?.success) {
          s.approval = null;
          this._chatKick();
        } else {
          s.answerError = 'That question is no longer on screen. Nothing was pressed.';
        }
      }
    } catch {
      s.answerError = 'That may not have gone through. It will not be retried. Check the terminal if this card stays.';
    } finally {
      clearTimeout(timer);
      s.answering = null;
      s.approvalAt = 0;
      if (this._chatShownId === id) this._chatRenderDock(id);
    }
  },

  _chatPromptCard(id, item, question, link) {
    const s = this._chat(id);
    const live = link === 'live';
    const card = document.createElement('div');
    card.className = 'chat-card chat-prompt-card';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'chat-card-eyebrow';
    eyebrow.textContent = question ? 'Claude is asking' : 'Needs your approval';
    card.appendChild(eyebrow);
    const title = document.createElement('div');
    title.className = 'chat-prompt-title';
    const pending = this._chatPendingTool();
    if (question) {
      const qs = question.tool.input?.questions || [];
      title.textContent = qs[0]?.question || item?.message || '';
      card.appendChild(title);
    } else {
      title.textContent = item?.message || item?.toolName || 'Claude is waiting for you';
      card.appendChild(title);
      const whatText = pending ? `${pending.name}: ${chatToolTitle(pending.name, pending.input)}` : item?.toolSummary;
      if (whatText) {
        const what = document.createElement('div');
        what.className = 'chat-prompt-what';
        what.textContent = whatText;
        card.appendChild(what);
      }
    }
    if (item?.options?.length && !item.answerInTerminal) {
      const list = document.createElement('div');
      list.className = 'chat-prompt-options';
      const descByLabel = new Map();
      for (const q of question?.tool.input?.questions || [])
        for (const o of q.options || []) descByLabel.set(o.label, o.description);
      for (const o of item.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chat-option';
        b.dataset.chat = 'answer';
        b.dataset.option = String(o.n);
        b.disabled = !live || !!s.answering;
        const label = document.createElement('span');
        label.className = 'chat-option-label';
        label.textContent = o.label;
        b.appendChild(label);
        const desc = descByLabel.get(o.label);
        if (desc) {
          const d = document.createElement('span');
          d.className = 'chat-option-desc';
          d.textContent = desc;
          b.appendChild(d);
        }
        list.appendChild(b);
      }
      card.appendChild(list);
    } else if (live && !s.approvalLoaded) {
      const wait = document.createElement('div');
      wait.className = 'chat-prompt-note';
      wait.textContent = 'Reading the question from the session…';
      card.appendChild(wait);
    } else {
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'chat-option';
      hint.dataset.chat = 'mode-terminal';
      hint.textContent = 'Answer in the terminal';
      hint.disabled = !live;
      card.appendChild(hint);
    }
    const noteText =
      s.answerError ||
      (live
        ? ''
        : 'You need a connection to answer. Answers are never saved for later, because the question may have changed by then.');
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'chat-prompt-note';
      note.textContent = noteText;
      card.appendChild(note);
    }
    return card;
  },

  // ── Composer ────────────────────────────────────────────────────────────
  _chatInputText(view) {
    const input = (view || this._chatViewEl())?.querySelector('.chat-input');
    return input ? input.innerText.replace(/ /g, ' ').replace(/\n+$/, '').trim() : '';
  },

  _chatRestoreDraft(id) {
    const view = this._chatViewEl();
    const input = view.querySelector('.chat-input');
    input.textContent = this._chat(id).draft || '';
    this._chatRenderUploads(id);
    this._chatPromptSig = null;
  },

  _chatRenderUploads(id) {
    const view = this._chatViewEl();
    const box = view.querySelector('.chat-uploads');
    const s = this._chat(id);
    box.replaceChildren();
    box.hidden = !s.uploads.length;
    s.uploads.forEach((u, index) => {
      const chip = document.createElement('div');
      chip.className = `chat-upload${u.path ? '' : ' is-uploading'}${u.error ? ' is-error' : ''}`;
      if (u.thumb) {
        const img = document.createElement('img');
        img.src = u.thumb;
        img.alt = '';
        chip.appendChild(img);
      } else {
        const name = document.createElement('span');
        name.textContent = u.name;
        chip.appendChild(name);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.dataset.chat = 'remove-upload';
      x.dataset.index = String(index);
      x.setAttribute('aria-label', 'Remove');
      x.innerHTML = CHAT_ICONS.close;
      chip.appendChild(x);
      box.appendChild(chip);
    });
    this._chatRenderDock(id);
  },

  async _chatAddFiles(files) {
    const id = this._chatShownId;
    if (!id || !files.length) return;
    const s = this._chat(id);
    for (const file of files) {
      const kind = this._promptAttachKind ? this._promptAttachKind(file) : 'image';
      if (kind === 'video') {
        this.showToast?.('Videos cannot be sent to remote sessions; images and documents can', 'error');
        continue;
      }
      const entry = {
        name: file.name || 'image',
        thumb: kind === 'image' && file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        path: null,
      };
      s.uploads.push(entry);
      this._chatRenderUploads(id);
      try {
        const ready = this._normalizeImageForUpload ? await this._normalizeImageForUpload(file) : file;
        entry.path = await this._uploadPasteImage(id, ready);
      } catch (err) {
        entry.error = true;
        this.showToast?.(`Upload failed: ${err.message}`, 'error');
        s.uploads.splice(s.uploads.indexOf(entry), 1);
      }
      if (this._chatShownId === id) this._chatRenderUploads(id);
    }
  },

  /** Decode an inserted image through a canvas (the page's CSP forbids fetching data:/blob: URLs). */
  _chatImageToFile(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        canvas.toBlob(
          (blob) =>
            blob ? resolve(new File([blob], 'pasted.png', { type: 'image/png' })) : reject(new Error('empty')),
          'image/png'
        );
      };
      img.onerror = () => reject(new Error('decode failed'));
      img.src = src;
    });
  },

  _chatKey(id, input) {
    return fetch(`/api/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    }).catch(() => {});
  },

  _chatSend(now = false) {
    const id = this._chatShownId;
    const view = this._chatViewEl();
    if (!id || !view) return;
    const s = this._chat(id);
    const core = chatCore();
    const status = this._chatStatus(id);
    const text = this._chatInputText(view);
    if (s.uploads.some((u) => !u.path)) {
      this.showToast?.('Still uploading…', 'info');
      return;
    }
    const paths = s.uploads.map((u) => u.path);
    const message = [paths.join(' '), text].filter(Boolean).join(' ');
    if (!message) {
      if (status.kind === 'live' && this._chatRowState(id)?.state === 'working') this._chatKey(id, '\x1b');
      return;
    }
    const limit = window.CodemanInputLimit?.FRAME_MAX_CHARS;
    if (limit && message.length + 1 > limit) {
      this.showToast?.(`Too long to send (limit ${Math.floor(limit / 1024)} KB); not sent`, 'error');
      return;
    }
    const ctx = this._chatOutboxContext(id, status);
    const entry = core.newOutboxEntry({
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: id,
      text: message,
      matchText: text,
      now: Date.now(),
      state: ctx.state,
      log: ctx.log,
      end: ctx.end || 0,
    });
    if (now && status.kind === 'live') {
      // Interrupt, give it a moment to land, and send regardless of the state change.
      this._chatKey(id, '\x1b');
      entry.approved = true;
      entry.notBefore = Date.now() + 450;
      setTimeout(() => this._chatPump(), 500);
    }
    this._chatOutbox().push(entry);
    this._chatSaveOutbox();
    for (const u of s.uploads) if (u.thumb) URL.revokeObjectURL(u.thumb);
    s.uploads = [];
    s.draft = '';
    view.querySelector('.chat-input').textContent = '';
    this._chatRenderUploads(id);
    this._chatRenderSlash();
    this._chatPump();
    this._chatRenderOutbox(id);
    // A command that opens a menu has nothing to show here: the menu is on the terminal.
    const menu = CHAT_BUILTIN_COMMANDS.find((c) => c.menu && message.trim().split(/\s/)[0] === `/${c.name}`);
    if (menu) setTimeout(() => this.setChatMode('terminal'), 300);
    const scroller = view.querySelector('.chat-scroll');
    scroller.scrollTop = scroller.scrollHeight;
  },

  _chatWire(view) {
    const input = view.querySelector('.chat-input');
    const fileInput = view.querySelector('.chat-file');

    view.addEventListener('click', (event) => {
      const target = event.target.closest('[data-chat]');
      if (!target || !view.contains(target)) {
        return;
      }
      const action = target.dataset.chat;
      const id = this._chatShownId;
      switch (action) {
        case 'back':
          this.chatBackToList();
          break;
        case 'mode-chat':
          this.setChatMode('chat');
          break;
        case 'mode-terminal':
          this.setChatMode('terminal');
          break;
        case 'options':
          if (id) this.openSessionOptions?.(id);
          break;
        case 'fold': {
          const box = target.parentElement;
          box.dataset.open = box.dataset.open === '1' ? '0' : '1';
          break;
        }
        case 'copy': {
          const text = target.parentElement.querySelector('pre')?.textContent || '';
          navigator.clipboard?.writeText(text).then(
            () => this.showToast?.('Copied', 'success'),
            () => this._copyText?.(text)
          );
          break;
        }
        case 'open-file':
          if (target.dataset.path) this.openFilePreview?.(target.dataset.path, target.dataset.sessionId || id);
          break;
        case 'open-agent':
          if (id) this.chatOpenAgent(id, target.dataset.tool, target.dataset.title);
          break;
        case 'close-agent':
          this.chatCloseAgent();
          break;
        case 'slash':
          this._chatSlashPick(target.dataset.name);
          break;
        case 'earlier':
          if (id) this._chatLoadEarlier(id);
          break;
        case 'answer':
          if (id) void this._chatAnswer(id, Number(target.dataset.option));
          break;
        case 'retry':
          this._chatRetryNow();
          break;
        case 'signin':
          this._chatSignIn();
          break;
        case 'ob-send': {
          const entry = this._chatOutbox().find((e) => e.id === target.dataset.ob);
          if (entry) this._chatOutboxSend(entry);
          break;
        }
        case 'ob-cancel': {
          const entry = this._chatOutbox().find((e) => e.id === target.dataset.ob);
          if (entry) this._chatRemoveOutbox(entry);
          break;
        }
        case 'ob-edit': {
          const entry = this._chatOutbox().find((e) => e.id === target.dataset.ob);
          if (!entry) break;
          this._chatRemoveOutbox(entry);
          const box = view.querySelector('.chat-input');
          const draft = this._chatInputText(view);
          box.textContent = draft ? `${entry.text}\n${draft}` : entry.text;
          this._chat(entry.sessionId).draft = box.textContent;
          box.focus();
          this._chatRenderDock(entry.sessionId);
          break;
        }
        case 'attach':
          fileInput.click();
          break;
        case 'remove-upload': {
          const s = this._chat(id);
          const [gone] = s.uploads.splice(Number(target.dataset.index), 1);
          if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
          this._chatRenderUploads(id);
          break;
        }
        case 'send':
          this._chatSend(false);
          break;
        case 'send-now':
          this._chatSend(true);
          break;
      }
    });
    this._bindResponseViewerInteractions?.(view.querySelector('.chat-log'));
    view.querySelector('.chat-title').addEventListener('dblclick', () => this._chatRenameTitle());
    view.querySelector('.chat-title').title = 'Double-click to rename';

    view.querySelector('.chat-scroll').addEventListener(
      'scroll',
      (event) => {
        // Only a person scrolling: a redraw also scrolls, and that must not spend the link.
        if (event.target.scrollTop >= 40 || !this._chatShownId) return;
        if (Date.now() - (this._chatUserScrollAt || 0) < 1500) this._chatLoadEarlier(this._chatShownId);
      },
      { passive: true }
    );
    for (const name of ['wheel', 'touchmove', 'keydown']) {
      view
        .querySelector('.chat-scroll')
        .addEventListener(name, () => (this._chatUserScrollAt = Date.now()), { passive: true });
    }

    fileInput.addEventListener('change', () => {
      this._chatAddFiles([...fileInput.files]);
      fileInput.value = '';
    });

    // Keyboards paste images into a rich field; take files, keep text plain.
    const takeTransfer = (event, dt) => {
      const files = [...(dt?.files || [])];
      if (files.length) {
        event.preventDefault();
        this._chatAddFiles(files);
        return true;
      }
      return false;
    };
    input.addEventListener('paste', (event) => {
      if (takeTransfer(event, event.clipboardData)) return;
      const text = event.clipboardData?.getData('text/plain');
      if (text != null) {
        event.preventDefault();
        document.execCommand('insertText', false, text);
      }
    });
    input.addEventListener('beforeinput', (event) => {
      if (event.dataTransfer) takeTransfer(event, event.dataTransfer);
    });
    input.addEventListener('drop', (event) => takeTransfer(event, event.dataTransfer));
    input.addEventListener('input', () => {
      // An image keyboard (Gboard) inserts an <img>: turn it into an upload.
      for (const img of [...input.querySelectorAll('img')]) {
        img.remove();
        this._chatImageToFile(img.src).then(
          (file) => this._chatAddFiles([file]),
          () => this.showToast?.('That image could not be read; try the + button', 'error')
        );
      }
      if (this._chatShownId) {
        this._chat(this._chatShownId).draft = input.innerText;
        this._chatRenderDock(this._chatShownId);
      }
      this._chatRenderSlash();
    });
    input.addEventListener('keydown', (event) => {
      const rows = this._chatSlashRows || [];
      if (rows.length && !event.isComposing) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          this._chatSlashAt = (this._chatSlashAt + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
          this._chatRenderSlash();
          return;
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !this._chatIsPhone())) {
          event.preventDefault();
          this._chatSlashPick(rows[this._chatSlashAt].name);
          return;
        }
        if (event.key === 'Escape') {
          this._chatSlashRows = [];
          view.querySelector('.chat-slash').hidden = true;
          return;
        }
      }
      // Desktop: Enter sends, Shift+Enter is a new line. Phone: Enter is a new line, like the app.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !this._chatIsPhone()) {
        event.preventDefault();
        this._chatSend(event.ctrlKey || event.metaKey);
      }
    });
  },

  // ── Phone session list ──────────────────────────────────────────────────
  _chatRenderHome() {
    const home = document.getElementById('chatHome');
    if (!home || home.hidden) return;
    home.querySelector('.chat-home-name').textContent = window.CodemanI18n?.displayName || 'Claude RC';
    const query = home.querySelector('input[type="search"]').value.trim().toLowerCase();
    const live = typeof this.buildHomeSessionRows === 'function' ? this.buildHomeSessionRows() : [];
    // Nothing from the server yet: the sessions as they were when this page last knew them.
    const directory = this._chatDirectory();
    const rows = live.length
      ? live
      : Object.entries(directory).map(([id, d]) => ({
          id,
          name: d.name || id.slice(0, 8),
          dir: d.folder,
          display: 'saved',
          pill: 'Saved',
        }));
    const groups = new Map();
    for (const row of rows) {
      const session = this.sessions?.get(row.id);
      const machine = session?.remote
        ? session.remote.label || session.remote.hostId
        : directory[row.id]?.where || 'This server';
      if (query && !`${row.name} ${row.dir} ${machine}`.toLowerCase().includes(query)) continue;
      if (!groups.has(machine)) groups.set(machine, []);
      groups.get(machine).push({ row, session });
    }
    const list = home.querySelector('.chat-home-list');
    const frag = document.createDocumentFragment();
    if (!groups.size) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = query ? 'No sessions match' : rows.length ? '' : 'No sessions yet. Start one below.';
      frag.appendChild(empty);
    }
    for (const [machine, entries] of groups) {
      const head = document.createElement('div');
      head.className = 'chat-home-group';
      head.textContent = machine;
      frag.appendChild(head);
      for (const { row, session } of entries) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `chat-home-row is-${row.display}`;
        b.dataset.session = row.id;
        const dot = document.createElement('span');
        dot.className = 'chat-home-dot';
        dot.setAttribute('aria-hidden', 'true');
        const main = document.createElement('span');
        main.className = 'chat-home-main';
        const name = document.createElement('span');
        name.className = 'chat-home-row-name';
        name.textContent = row.name;
        const sub = document.createElement('span');
        sub.className = 'chat-home-row-sub';
        const folder = session?.remote?.remotePath || session?.workingDir || row.dir;
        sub.textContent = [CHAT_STATE_LABEL[row.display] || row.pill, chatBasename(folder), row.watching]
          .filter(Boolean)
          .join(' · ');
        main.append(name, sub);
        const when = document.createElement('span');
        when.className = 'chat-home-when';
        const at = row.since?.at || row.lastActivityAt;
        when.textContent = at ? this._chatAgo(at) : '';
        b.append(dot, main, when);
        frag.appendChild(b);
      }
    }
    // Redraw only on change: a rebuild under a finger can swallow the tap.
    const signature = [...frag.childNodes].map((n) => n.textContent + (n.className || '')).join('|');
    if (signature === list.dataset.signature) return;
    list.dataset.signature = signature;
    list.replaceChildren(frag);
  },

  /** Context reading for a session, or null (the status bar shows the active one). */
  chatContextFor(id) {
    return (id && this._chatSessions?.get(id)?.context) || null;
  },

  /** Inline rename of the conversation title (double-click or double-tap). */
  _chatRenameTitle() {
    const id = this._chatShownId;
    const view = this._chatViewEl();
    const title = view?.querySelector('.chat-title');
    if (!id || !title || title.isContentEditable) return;
    const before = title.textContent;
    title.contentEditable = 'plaintext-only';
    title.classList.add('is-editing');
    title.focus();
    document.getSelection()?.selectAllChildren(title);
    const finish = async (save) => {
      title.removeEventListener('keydown', onKey);
      title.removeEventListener('blur', onBlur);
      title.contentEditable = 'false';
      title.classList.remove('is-editing');
      const name = title.textContent.replace(/\s+/g, ' ').trim();
      if (!save || !name || name === before) {
        title.textContent = before;
        return;
      }
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/name`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const session = this.sessions.get(id);
        if (session) session.name = name;
        this.renderSessionTabs?.();
      } catch (err) {
        title.textContent = before;
        this.showToast?.(`Rename failed: ${err.message}`, 'error');
      }
    };
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    title.addEventListener('keydown', onKey);
    title.addEventListener('blur', onBlur);
  },

  _chatAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },
});

(function wireChatView() {
  const proto = CodemanApp.prototype;
  const select = proto.selectSession;
  proto.selectSession = async function (...args) {
    const result = await select.apply(this, args);
    this.chatSync?.();
    return result;
  };
  const goHome = proto.goHome;
  proto.goHome = function (...args) {
    const result = goHome.apply(this, args);
    this._chatOfflineId = null;
    this.chatSync?.();
    return result;
  };
  // While chat covers the session, everything that would feed or size the main terminal
  // stands aside, the same way these paths do for the tile grid. Switching to the
  // terminal reloads it (setChatMode).
  const stand = (name, answer) => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function (...args) {
      const id = typeof args[0] === 'string' ? args[0] : this.activeSessionId;
      if (this._chatParksTerminal?.(id)) return answer;
      return original.apply(this, args);
    };
  };
  stand('_onSessionNeedsRefresh', false);
  stand('_onSessionClearTerminal', undefined);
  stand('_scheduleDroppedOutputRecovery', undefined);
  stand('sendResize', Promise.resolve(false));
  const connectWs = proto._connectWs;
  proto._connectWs = function (sessionId) {
    if (this._chatParksTerminal?.(sessionId)) {
      this._disconnectWs();
      // Input goes over POST while parked, which is what this state means.
      this._wsState = 'fallback';
      this._updateConnectionIndicator?.();
      return undefined;
    }
    return connectWs.call(this, sessionId);
  };
  const sseFilter = proto._sseFilterSessionId;
  proto._sseFilterSessionId = function (sessionId) {
    if (this._chatParksTerminal?.(sessionId)) return CHAT_SSE_FILTER;
    return sseFilter.call(this, sessionId);
  };
  // Events say when to read; each new stream gets the listeners once.
  const connectSSE = proto.connectSSE;
  proto.connectSSE = function (...args) {
    const result = connectSSE.apply(this, args);
    const stream = this.eventSource;
    if (stream && stream !== this._chatNudgedStream) {
      this._chatNudgedStream = stream;
      const onEvent = (event) => {
        const shown = this._chatShownId;
        if (!shown) return;
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        const id = data?.id || data?.sessionId;
        if (id && id !== shown) return;
        this._chatKick();
        this._chat(shown).approvalAt = 0;
      };
      for (const name of CHAT_NUDGE_EVENTS) stream.addEventListener(name, onEvent);
    }
    return result;
  };
  // Double-click a session tab or rail row to rename it (right-click still works too).
  document.addEventListener('dblclick', (event) => {
    const tab = event.target.closest?.('.session-tab[data-id]');
    if (!tab || event.target.closest('input, button, .tab-rename-input')) return;
    event.preventDefault();
    window.app?.startInlineRename?.(tab.dataset.id);
  });
  window.addEventListener('popstate', () => {
    const app = window.app;
    if (!app?._chatIsPhone?.() || app._chatMode?.() !== 'chat') return;
    if (history.state?.chat === 'session' || !app._chatShownId) return;
    app._chatHistoryId = null;
    app._chatGoHome();
  });
  const start = () => {
    const app = window.app;
    if (!app) return setTimeout(start, 300);
    // Back from the login page: the marker has done its job.
    if (/[?&]signin=1\b/.test(location.search)) {
      try {
        const url = new URL(location.href);
        url.searchParams.delete('signin');
        history.replaceState(history.state, '', url);
      } catch {
        /* keep the URL */
      }
    }
    app.chatSync();
    setInterval(() => {
      if (document.hidden) return;
      app.chatSync();
    }, CHAT_TICK_MS);
    window.matchMedia?.(CHAT_PHONE_QUERY).addEventListener?.('change', () => app.chatSync());
    // Back on the network, or back in front of the user: read now, never wait out a backoff.
    // The link counts as live only once a read has worked; a wake only reads sooner.
    const wake = () => {
      for (const list of app._pendingDeliveries?.values() || []) for (const rec of list) rec.retryAt = 0;
      app._chatRenderLink();
      app._chatKick({ force: true });
    };
    window.addEventListener('online', wake);
    // Another tab changed the outbox: read it again rather than overwrite it later.
    window.addEventListener('storage', (event) => {
      if (event.key !== CHAT_OUTBOX_KEY) return;
      app._chatOutboxData = null;
      if (app._chatShownId) app._chatRenderOutbox(app._chatShownId);
    });
    window.addEventListener('offline', () => {
      const link = app._chatLinkState();
      link.failures = Math.max(1, link.failures);
      app._chatRenderLink();
      if (app._chatShownId) app._chatRenderDock(app._chatShownId);
      app._chatArm({ fresh: true });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(app._chatTimer);
        app._chatTimer = null;
      } else wake();
    });
    // Everything this page loaded goes into the service worker's cache, so the next
    // start needs no network: fonts and lazily loaded modules are not in its list.
    const shareAssets = () => {
      const urls = (performance.getEntriesByType?.('resource') || [])
        .map((r) => r.name)
        .filter((u) => u.startsWith(location.origin) && !u.includes('/api/') && !u.includes('/ws/'));
      navigator.serviceWorker?.ready
        .then((reg) => reg.active?.postMessage({ type: 'cache-assets', urls }))
        .catch(() => {});
    };
    setTimeout(shareAssets, 4000);
    navigator.serviceWorker?.addEventListener('controllerchange', shareAssets);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
