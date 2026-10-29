// Port: none (pure functions — no browser, no server).
//
// The chat view (fork) draws a Claude session from its conversation log. Pinned here:
// the server-side line parser and log lookup (src/chat-transcript.ts), and the two pure
// pieces of src/web/public/chat-view.js that decide what the user sees and presses:
// how log entries fold into display items, and how a dialog's numbered options are read
// off the terminal screen (the buttons on a permission or question card press those keys).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildLocateScript, parseChatChunk, parseChatLine } from '../src/chat-transcript.js';

function loadChatView(): any {
  const CodemanApp = function CodemanApp(this: any) {};
  const window: any = { addEventListener() {} };
  const context = vm.createContext({
    CodemanApp,
    window,
    document: { readyState: 'loading', addEventListener() {} },
    history: {},
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
    setInterval,
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/chat-view.js'), 'utf8'), context);
  return window.CodemanChat;
}

const line = (o: unknown) => JSON.stringify(o);

describe('parseChatLine', () => {
  it('keeps text, tool calls and tool results, and drops bookkeeping lines', () => {
    const assistant = parseChatLine(
      line({
        type: 'assistant',
        uuid: 'a1',
        timestamp: 't',
        message: {
          model: 'claude-opus-5-5',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      })
    );
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(parseChatLine(line({ type: 'file-history-snapshot' }))).toBeNull();
    expect(parseChatLine(line({ type: 'api-request-blob', data: 'x' }))).toBeNull();
    expect(parseChatLine('{not json')).toBeNull();
  });

  it('turns a message sent mid-turn into a queued user entry, and ignores machine-made ones', () => {
    const queued = parseChatLine(
      line({
        type: 'attachment',
        uuid: 'q1',
        attachment: { type: 'queued_command', prompt: 'send now please', origin: { kind: 'human' } },
      })
    );
    expect(queued).toMatchObject({ role: 'user', queued: true, blocks: [{ type: 'text', text: 'send now please' }] });
    expect(
      parseChatLine(
        line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'x', origin: { kind: 'task' } } })
      )
    ).toBeNull();
  });

  it('cuts very large tool output', () => {
    const big = 'x'.repeat(50_000);
    const entry = parseChatLine(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: big }] } })
    );
    expect(entry?.blocks[0].text!.length).toBeLessThan(7_000);
  });
});

describe('parseChatChunk', () => {
  it('returns only complete lines and the offset just past the last one', () => {
    const a = line({ type: 'user', message: { content: 'one' } });
    const b = line({ type: 'user', message: { content: 'two' } });
    const buf = Buffer.from(`${a}\n${b}\n{"type":"user","mess`);
    const parsed = parseChatChunk(buf, 100, false);
    expect(parsed.entries.map((e) => e.blocks[0].text)).toEqual(['one', 'two']);
    expect(parsed.end).toBe(100 + a.length + 1 + b.length + 1);
  });

  it('drops the partial first line of a mid-file read', () => {
    const b = line({ type: 'user', message: { content: 'two' } });
    const parsed = parseChatChunk(Buffer.from(`tail of a line"}\n${b}\n`), 50, true);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.start).toBe(50 + 'tail of a line"}'.length + 1);
  });
});

describe('buildLocateScript', () => {
  it('looks up the live conversation by tmux pane first, then the launch id', () => {
    const script = buildLocateScript('codeman-ssh-e80bacc4', 'e80bacc4-7f16-4e9b-9d16-03edc8b39b62');
    expect(script.indexOf('"tmux":"codeman-ssh-e80bacc4:')).toBeGreaterThan(-1);
    expect(script.indexOf('e80bacc4-7f16-4e9b-9d16-03edc8b39b62.jsonl')).toBeGreaterThan(script.indexOf('sessions/'));
    expect(script).toContain('/mnt/c/Users/*/.claude');
  });

  it('cannot be steered into shell syntax by a hostile name or id', () => {
    const script = buildLocateScript("x'; rm -rf ~; '", '$(reboot)');
    expect(script).not.toContain('rm -rf');
    expect(script).not.toContain('$(reboot)');
  });
});

describe('buildChatItems', () => {
  const chat = loadChatView();
  const entry = (role: string, blocks: any[], extra: any = {}) => ({
    uuid: Math.random().toString(36),
    role,
    timestamp: '',
    blocks,
    ...extra,
  });

  it('folds consecutive tool calls into one activity row and splits file edits into cards', () => {
    const items = chat.buildChatItems([
      entry('user', [{ type: 'text', text: 'fix it' }]),
      entry('assistant', [
        { type: 'text', text: 'Looking' },
        { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: '2', name: 'Read', input: { file_path: '/a/b.ts' } },
        {
          type: 'tool_use',
          id: '3',
          name: 'Edit',
          input: { file_path: '/a/b.ts', old_string: 'a', new_string: 'b\nc' },
        },
      ]),
      entry('user', [
        { type: 'tool_result', toolUseId: '1', text: 'x' },
        { type: 'tool_result', toolUseId: '2', text: 'y' },
      ]),
      entry('assistant', [{ type: 'text', text: 'Done' }]),
    ]);
    expect(items.map((i: any) => i.kind)).toEqual(['user', 'text', 'activity', 'file', 'text']);
    expect(items[2].tools.map((t: any) => t.name)).toEqual(['Bash', 'Read', 'Edit']);
    expect(items[3].tool.result).toBeNull();
    expect(chat.chatActivitySummary(items[2].tools)).toBe('Ran 1 command, read 1 file, edited 1 file');
  });

  it('shows slash commands, hides meta and subagent lines, keeps questions', () => {
    const items = chat.buildChatItems([
      entry('user', [{ type: 'text', text: '<command-name>/model</command-name><command-args>opus</command-args>' }]),
      entry('user', [{ type: 'text', text: 'Caveat: internal' }], { meta: true }),
      entry('assistant', [{ type: 'text', text: 'side' }], { sidechain: true }),
      entry('assistant', [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [] } }]),
    ]);
    expect(items.map((i: any) => i.kind)).toEqual(['user', 'question']);
    expect(items[0]).toMatchObject({ text: '/model opus', command: true });
  });
});

describe('parseScreenOptions', () => {
  const chat = loadChatView();

  it('reads a boxed permission dialog', () => {
    const parsed = chat.parseScreenOptions([
      '╭──────────────────────────────╮',
      '│ Bash command                 │',
      '│   npm test                   │',
      '│ Do you want to proceed?      │',
      '│ ❯ 1. Yes                     │',
      "│   2. Yes, and don't ask again │",
      '│   3. No, and tell Claude what to do differently (esc) │',
      '╰──────────────────────────────╯',
      '',
    ]);
    expect(parsed.title).toBe('Do you want to proceed?');
    expect(parsed.options.map((o: any) => o.key)).toEqual(['1', '2', '3']);
    expect(parsed.options[0]).toMatchObject({ label: 'Yes', selected: true });
  });

  it('skips description lines between options and ignores a list that does not start at 1', () => {
    const parsed = chat.parseScreenOptions([
      'Pick one',
      '❯ 1. Phone',
      '     Build it first',
      '  2. Desktop',
      '     Later',
    ]);
    expect(parsed.options.map((o: any) => o.label)).toEqual(['Phone', 'Desktop']);
    expect(chat.parseScreenOptions(['  3. Third', '  4. Fourth'])).toBeNull();
    expect(chat.parseScreenOptions(['nothing to choose'])).toBeNull();
  });
});
