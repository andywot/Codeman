/**
 * @fileoverview Chat view (fork): a Claude session as a conversation, the way the
 * Claude phone app shows it, with the live terminal one tap away.
 *
 * The conversation comes from Claude Code's own log (GET /api/sessions/:id/chat,
 * src/chat-transcript.ts), polled by byte offset while the view is open, for local
 * and remote sessions alike. Replies render as markdown; tool calls fold into one
 * "Ran 3 commands, read 2 files" line per stretch of work that expands to each call
 * and its output; files Claude writes or edits become cards that open the file
 * preview; a question (AskUserQuestion) or permission prompt that is waiting on
 * you becomes a card of buttons. The options on those cards are read from the live
 * terminal screen, so a button always presses what the dialog actually offers.
 *
 * Composer: a contenteditable box (a phone keyboard will paste images into it,
 * which it refuses for the terminal's plain textarea), an attach button, and send.
 * While Claude works, send queues the message into the running turn (Claude Code's
 * own queue), "Send now" interrupts first, and the empty-composer button stops.
 *
 * Phone (< 768px): a session list (by machine) and a full-screen conversation with
 * a back arrow, like the Claude app. The terminal is the header's terminal button;
 * the browser back gesture returns to the list. Desktop: a Chat / Terminal switch
 * over the session area. Mode is remembered per device (`codeman:chatMode`).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (_renderMarkdown, _linkifyFilePaths, _bindResponseViewerInteractions, _sendInputAsync)
 * @dependency image-input.js (_normalizeImageForUpload, _uploadPasteImage)
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar._sendComposedPrompt)
 * @dependency home-sessions.js (buildHomeSessionRows)
 * @dependency panels-ui.js (openFilePreview)
 * @loadorder after status-bar.js
 */

const CHAT_POLL_MS = 1500;
const CHAT_PHONE_QUERY = '(max-width: 767px)';
const CHAT_MODE_KEY = 'codeman:chatMode';
const CHAT_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CHAT_STATE_LABEL = {
  needs: 'Needs you',
  error: 'Error',
  waiting: 'Your turn',
  working: 'Working',
  idle: 'Idle',
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
 * Turn log entries into display items. Pure; exported for tests.
 * Items: user, text, thinking, activity (a run of tool calls), file, question, todo, note.
 */
function buildChatItems(entries) {
  const results = new Map();
  for (const e of entries) {
    if (e.role !== 'user') continue;
    for (const b of e.blocks) if (b.type === 'tool_result' && b.toolUseId) results.set(b.toolUseId, b);
  }
  const items = [];
  let activity = null;
  const flush = () => {
    activity = null;
  };
  for (const e of entries) {
    if (e.sidechain) continue;
    if (e.role === 'system') {
      flush();
      const text = e.blocks
        .map((b) => b.text || '')
        .join('\n')
        .trim();
      if (text) items.push({ kind: 'note', key: e.uuid, text: chatOneLine(text, 200) });
      continue;
    }
    if (e.role === 'user') {
      if (e.meta) continue;
      const texts = e.blocks.filter((b) => b.type === 'text').map((b) => b.text || '');
      const images = e.blocks.filter((b) => b.type === 'image').length;
      if (!texts.length && !images) continue;
      const raw = texts.join('\n').trim();
      if (/^<(local-command-caveat|system-reminder)>/.test(raw)) continue;
      flush();
      const command = raw.match(/<command-name>([^<]*)<\/command-name>/);
      if (command) {
        const args = (raw.match(/<command-args>([^<]*)<\/command-args>/) || [])[1] || '';
        items.push({ kind: 'user', key: e.uuid, text: `${command[1]} ${args}`.trim(), command: true });
        continue;
      }
      const stdout = raw.match(/^<local-command-std(?:out|err)>([\s\S]*)<\/local-command-std(?:out|err)>$/);
      if (stdout) {
        const out = stdout[1].replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (out) items.push({ kind: 'note', key: e.uuid, text: chatOneLine(out, 300) });
        continue;
      }
      if (/^\[Request interrupted by user/.test(raw)) {
        items.push({ kind: 'note', key: e.uuid, text: 'Interrupted' });
        continue;
      }
      items.push({ kind: 'user', key: e.uuid, text: raw, images, queued: !!e.queued, at: e.timestamp });
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
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role === 'assistant' && !e.sidechain && e.usage && e.usage.context > 0) {
      return { used: e.usage.context, limit: chatContextLimit(e.model), model: e.model || '' };
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
    return stored === 'terminal' || stored === 'chat' ? stored : 'chat';
  },

  setChatMode(mode) {
    try {
      localStorage.setItem(CHAT_MODE_KEY, mode);
    } catch {
      /* storage blocked */
    }
    this.chatSync();
    if (mode === 'terminal') setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
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
        drafts: '',
        uploads: [],
      };
      this._chatSessions.set(id, s);
    }
    return s;
  },

  _chatSupported(id) {
    const session = this.sessions?.get(id);
    if (!session) return false;
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
      <div class="chat-scroll">
        <div class="chat-log" role="log" aria-live="polite"></div>
      </div>
      <div class="chat-dock">
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
    });
    el.querySelector('input[type="search"]').addEventListener('input', () => this._chatRenderHome());
    return el;
  },

  // ── Navigation ──────────────────────────────────────────────────────────
  /** Phone: open one session's conversation (pushes a history entry so Back returns to the list). */
  chatOpenSession(id) {
    if (!id) return;
    this._chatPhoneScreen = 'session';
    if (this._chatIsPhone() && history.state?.chat !== 'session') {
      try {
        history.pushState({ chat: 'session' }, '');
      } catch {
        /* sandboxed */
      }
    }
    if (this.activeSessionId !== id) this.selectSession(id);
    this.chatSync();
  },

  chatBackToList() {
    if (history.state?.chat === 'session') {
      history.back();
      return;
    }
    this._chatPhoneScreen = 'home';
    this.chatSync();
  },

  /** Decide what is on screen; called on selection changes and from the poll timer. */
  chatSync() {
    const view = this._chatViewEl();
    if (!view) return;
    const phone = this._chatIsPhone();
    const mode = this._chatMode();
    const root = document.documentElement;
    const id = this.activeSessionId;
    const home = phone ? this._chatHomeEl() : document.getElementById('chatHome');
    if (this._chatPhoneScreen === undefined) this._chatPhoneScreen = 'home';

    const showHome = phone && mode === 'chat' && (this._chatPhoneScreen === 'home' || !id || !this.sessions?.has(id));
    const showChat = mode === 'chat' && !showHome && !!id && this._chatSupported(id);
    if (home) home.hidden = !showHome;
    view.hidden = !showChat;
    root.dataset.chat = showHome ? 'home' : showChat ? 'session' : 'off';
    root.dataset.chatPhone = phone ? 'on' : 'off';
    this._chatTerminalPill(mode === 'terminal' && !!id && this._chatSupported(id));

    if (showHome) this._chatRenderHome();
    // Keep the active session's log read in terminal mode too, for the context reading.
    if (!showChat && id && this._chatSupported(id)) this._chatPoll(id);
    if (showChat) {
      if (this._chatShownId !== id) {
        this._chatShownId = id;
        this._chatRestoreDraft(id);
        this._chatRender(id, { toBottom: true });
      }
      this._chatRenderHead(id);
      this._chatPoll(id);
    } else if (this._chatShownId && this._chatShownId !== id) {
      this._chatShownId = null;
    }
  },

  /** Phone, terminal mode: a small floating button back to the chat view. */
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

  // ── Data ────────────────────────────────────────────────────────────────
  async _chatFetch(id, params) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/chat?${new URLSearchParams(params)}`);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
    return json.data;
  },

  async _chatPoll(id) {
    const s = this._chat(id);
    if (s.busy || document.hidden) return;
    s.busy = true;
    try {
      const fresh = !s.loaded;
      const data = await this._chatFetch(id, fresh ? { after: -1 } : { after: s.end });
      s.found = data.found;
      if (!data.found) {
        s.loaded = true;
      } else if (fresh || data.log !== s.log) {
        Object.assign(s, { log: data.log, start: data.start, end: data.end, entries: data.entries, loaded: true });
        if (this._chatShownId === id) this._chatRender(id, { toBottom: true });
      } else if (data.entries.length || data.end !== s.end) {
        s.end = data.end;
        s.entries.push(...data.entries);
        if (this._chatShownId === id) this._chatRender(id);
      }
      const context = latestChatContext(s.entries);
      if (context) s.context = context;
      s.error = null;
    } catch (err) {
      s.error = err.message;
    } finally {
      s.busy = false;
    }
    if (this._chatShownId === id) this._chatRenderDock(id);
  },

  async _chatLoadEarlier(id) {
    const s = this._chat(id);
    if (s.busy || !s.start) return;
    s.busy = true;
    try {
      const data = await this._chatFetch(id, { before: s.start });
      if (data.log === s.log) {
        s.start = data.start;
        s.entries.unshift(...data.entries);
        this._chatRender(id, { keepFromBottom: true });
      }
    } catch (err) {
      this.showToast?.(`Could not load earlier messages: ${err.message}`, 'error');
    } finally {
      s.busy = false;
    }
  },

  // ── Rendering ───────────────────────────────────────────────────────────
  _chatRowState(id) {
    const rows = typeof this.buildHomeSessionRows === 'function' ? this.buildHomeSessionRows() : [];
    return rows.find((r) => r.id === id) || null;
  },

  _chatRenderHead(id) {
    const view = this._chatViewEl();
    const session = this.sessions.get(id);
    if (!view || !session) return;
    const row = this._chatRowState(id);
    view.querySelector('.chat-title').textContent = row?.name || session.name || id.slice(0, 8);
    const where = session.remote ? session.remote.label || session.remote.hostId : 'This server';
    const folder = chatBasename(session.remote?.remotePath || session.workingDir || '');
    view.querySelector('.chat-subtitle').textContent = [where, folder].filter(Boolean).join(' · ');
    view.querySelector('.chat-spinner').classList.toggle('on', row?.state === 'working');
    view.querySelector('[data-chat="mode-chat"]').setAttribute('aria-pressed', 'true');
    const model = session.displayModel || session.model || '';
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
    const open = new Set([...log.querySelectorAll('[data-open="1"]')].map((n) => n.dataset.key));

    const frag = document.createDocumentFragment();
    if (s.start > 0) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chat-earlier';
      more.dataset.chat = 'earlier';
      more.textContent = 'Load earlier messages';
      frag.appendChild(more);
    }
    if (s.loaded && !s.found) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.innerHTML =
        '<p>No messages yet.</p><p class="chat-empty-hint">Send a message below, or open the terminal if Claude is still starting.</p>';
      frag.appendChild(empty);
    } else if (!s.loaded) {
      const loading = document.createElement('div');
      loading.className = 'chat-empty';
      loading.textContent = 'Loading conversation…';
      frag.appendChild(loading);
    }
    const items = buildChatItems(s.entries);
    this._chatItems = items;
    for (const item of items) {
      const node = this._chatRenderItem(id, item);
      if (!node) continue;
      if (open.has(item.key)) node.dataset.open = '1';
      frag.appendChild(node);
    }
    log.replaceChildren(frag);
    if (toBottom || nearBottom) scroller.scrollTop = scroller.scrollHeight;
    else if (keepFromBottom) scroller.scrollTop = scroller.scrollHeight - fromBottom;
    this._chatRenderDock(id);
  },

  _chatRenderItem(id, item) {
    const el = document.createElement('div');
    el.dataset.key = item.key;
    switch (item.kind) {
      case 'user': {
        el.className = `chat-msg chat-user${item.command ? ' chat-user--command' : ''}`;
        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = item.text;
        if (item.images) {
          const tag = document.createElement('div');
          tag.className = 'chat-bubble-tag';
          tag.textContent = `${item.images} image${item.images > 1 ? 's' : ''}`;
          bubble.appendChild(tag);
        }
        el.appendChild(bubble);
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
      case 'note': {
        el.className = 'chat-note';
        el.textContent = item.text;
        return el;
      }
      default:
        return null;
    }
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
  _chatScreenLines() {
    const term = this.terminal;
    const buf = term?.buffer?.active;
    if (!buf) return [];
    const lines = [];
    const end = buf.baseY + term.rows;
    for (let y = Math.max(0, end - 40); y < end; y++) lines.push(buf.getLine(y)?.translateToString(true) || '');
    return lines;
  },

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

    // A dialog waiting on you: its options come off the live screen.
    const screen =
      state === 'needs' && this.activeSessionId === id ? parseScreenOptions(this._chatScreenLines()) : null;
    const question = this._chatPendingQuestion();
    const signature = screen ? JSON.stringify(screen) + (question?.key || '') : state === 'needs' ? 'needs' : '';
    if (signature !== this._chatPromptSig) {
      this._chatPromptSig = signature;
      prompt.replaceChildren();
      if (state === 'needs') {
        prompt.hidden = false;
        prompt.appendChild(this._chatPromptCard(screen, question));
      } else prompt.hidden = true;
    }

    const s = this._chat(id);
    const bits = [];
    if (s.error) bits.push(`<span class="chat-status-err">${chatEsc(s.error)}</span>`);
    else if (working) {
      const watch = row?.watching ? ` · ${chatEsc(row.watching)}` : '';
      bits.push(
        `<span class="chat-working"><span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>Working…${watch}</span>`
      );
    } else if (row?.display === 'exited') bits.push('<span>Claude exited in this session.</span>');
    status.hidden = !bits.length;
    status.innerHTML = bits.join('');

    const hasText = !!this._chatInputText(view) || s.uploads.some((u) => u.path);
    const send = view.querySelector('.chat-send');
    const stopMode = working && !hasText;
    send.classList.toggle('is-stop', stopMode);
    send.innerHTML = stopMode ? CHAT_ICONS.stop : CHAT_ICONS.send;
    send.setAttribute('aria-label', stopMode ? 'Stop Claude' : working ? 'Queue message' : 'Send');
    send.title = stopMode ? 'Stop' : working ? 'Send when Claude finishes this step' : 'Send';
    send.disabled = !stopMode && !hasText;
    view.querySelector('.chat-sendnow').hidden = !(working && hasText);

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

  _chatPromptCard(screen, question) {
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
      title.textContent =
        (screen?.title && qs.find((q) => screen.title.includes(q.header || '\u0000'))?.question) ||
        qs[0]?.question ||
        screen?.title ||
        '';
    } else {
      title.textContent = screen?.title || 'Claude is waiting for you';
      if (pending) {
        const what = document.createElement('div');
        what.className = 'chat-prompt-what';
        what.textContent = `${pending.name}: ${chatToolTitle(pending.name, pending.input)}`;
        card.appendChild(title);
        card.appendChild(what);
      }
    }
    if (!card.contains(title)) card.appendChild(title);
    if (screen?.options?.length) {
      const list = document.createElement('div');
      list.className = 'chat-prompt-options';
      const descByLabel = new Map();
      for (const q of question?.tool.input?.questions || [])
        for (const o of q.options || []) descByLabel.set(o.label, o.description);
      for (const o of screen.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chat-option';
        b.dataset.chat = 'answer';
        b.dataset.key = o.key;
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
    } else {
      const hint = document.createElement('button');
      hint.type = 'button';
      hint.className = 'chat-option';
      hint.dataset.chat = 'mode-terminal';
      hint.textContent = 'Answer in the terminal';
      card.appendChild(hint);
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
    const row = this._chatRowState(id);
    const text = this._chatInputText(view);
    if (s.uploads.some((u) => !u.path)) {
      this.showToast?.('Still uploading…', 'info');
      return;
    }
    const paths = s.uploads.map((u) => u.path);
    const message = [paths.join(' '), text].filter(Boolean).join(' ');
    if (!message) {
      if (row?.state === 'working') this._chatKey(id, '\x1b');
      return;
    }
    const deliver = () => {
      const bar = window.KeyboardAccessoryBar;
      if (bar?._sendComposedPrompt) bar._sendComposedPrompt(id, message);
      else this._sendInputAsync(id, `${message}\r`, { useMux: true });
    };
    if (now && row?.state === 'working') {
      this._chatKey(id, '\x1b');
      setTimeout(deliver, 450);
    } else deliver();
    for (const u of s.uploads) if (u.thumb) URL.revokeObjectURL(u.thumb);
    s.uploads = [];
    s.draft = '';
    view.querySelector('.chat-input').textContent = '';
    this._chatRenderUploads(id);
    // Show the message at once; the log catches up on the next poll.
    const scroller = view.querySelector('.chat-scroll');
    const pending = document.createElement('div');
    pending.className = 'chat-msg chat-user is-pending';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = message;
    pending.appendChild(bubble);
    view.querySelector('.chat-log').appendChild(pending);
    scroller.scrollTop = scroller.scrollHeight;
    setTimeout(() => this._chatPoll(id), 900);
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
        case 'earlier':
          if (id) this._chatLoadEarlier(id);
          break;
        case 'answer':
          if (id) {
            this._chatKey(id, target.dataset.key);
            target.closest('.chat-prompt-card')?.classList.add('is-sent');
            setTimeout(() => this._chatPoll(id), 700);
          }
          break;
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

    view.querySelector('.chat-scroll').addEventListener('scroll', (event) => {
      if (event.target.scrollTop < 40 && this._chatShownId) this._chatLoadEarlier(this._chatShownId);
    });

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
    });
    input.addEventListener('keydown', (event) => {
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
    const rows = typeof this.buildHomeSessionRows === 'function' ? this.buildHomeSessionRows() : [];
    const groups = new Map();
    for (const row of rows) {
      const session = this.sessions.get(row.id);
      const machine = session?.remote ? session.remote.label || session.remote.hostId : 'This server';
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
    this.chatSync?.();
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
    if (!app?._chatIsPhone?.()) return;
    app._chatPhoneScreen = history.state?.chat === 'session' ? 'session' : 'home';
    app.chatSync();
  });
  const start = () => {
    const app = window.app;
    if (!app) return setTimeout(start, 300);
    app.chatSync();
    setInterval(() => {
      if (document.hidden) return;
      app.chatSync();
    }, CHAT_POLL_MS);
    window.matchMedia?.(CHAT_PHONE_QUERY).addEventListener?.('change', () => app.chatSync());
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
