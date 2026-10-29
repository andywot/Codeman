/**
 * @fileoverview Appearance (App Settings → Appearance → Look): accent colour, UI font, data font, UI size.
 *
 * Pins the pure helpers in constants.js (CodemanAppearance: validation, contrast, ink and fill choice,
 * the plan that goes on <html>), that the inline pre-paint script in index.html is the same plan, the
 * CSS the plan relies on (the --fs-* scale, the color-mix derivation block, no label painted white on a
 * raw accent), and the per-device settings contract (displayKeys yes, SettingsUpdateSchema no, stripped
 * from the settings PUT) plus the zh-CN strings.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');
const CONSTANTS = read('constants.js');
const INDEX = read('index.html');
const STYLES = read('styles.css');
const MOBILE = read('mobile.css');
const CHAT = read('chat.css');
const SETTINGS_UI = read('settings-ui.js');
const I18N = read('i18n.js');

interface Plan {
  accent: string;
  uiFont: string;
  dataFont: string;
  scale: number;
  vars: Record<string, string | null>;
  accentAttr: string | null;
}
interface Appearance {
  ACCENT_PRESETS: { id: string; label: string; hex: string }[];
  DEFAULT_ACCENT: string;
  UI_FONTS: Record<string, string | null>;
  MONO_FONTS: Record<string, string | null>;
  SCALES: number[];
  INK_LIGHT: string;
  INK_DARK: string;
  MIN_INK_CONTRAST: number;
  parseHex(v: unknown): string | null;
  luminance(hex: string): number;
  contrast(a: string, b: string): number;
  inkFor(hex: string): string;
  fillFor(hex: string): string;
  normalizeAccent(v: unknown): string;
  normalizeScale(v: unknown): number;
  plan(raw: unknown): Plan;
  apply(plan: Plan, root: unknown): void;
}

function loadAppearance(): Appearance {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(CONSTANTS, context, { filename: 'constants.js' });
  return (context.window as { CodemanAppearance: Appearance }).CodemanAppearance;
}
const A = loadAppearance();

/** A tiny stand-in for document.documentElement: style.setProperty/removeProperty plus attributes. */
function fakeRoot() {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    props,
    attrs,
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => void props.delete(k),
    },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
}

describe('CodemanAppearance.parseHex (validation of a custom colour)', () => {
  it('accepts #rgb and #rrggbb in any case and normalizes to lowercase #rrggbb', () => {
    expect(A.parseHex('#E14775')).toBe('#e14775');
    expect(A.parseHex('  #1c8ca8 ')).toBe('#1c8ca8');
    expect(A.parseHex('#abc')).toBe('#aabbcc');
  });

  it('refuses everything else, including anything that could ride into a style declaration', () => {
    for (const bad of [
      '',
      'red',
      'e14775',
      '#e1477',
      '#e147755',
      '#e14775ff',
      '#ggg',
      'rgb(1,2,3)',
      'hsl(0 0% 0%)',
      '#fff;background:url(//x)',
      '#fff} body{display:none',
      'var(--x)',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(A.parseHex(bad), String(bad)).toBeNull();
    }
  });

  it('stores the Monokai pink as no override, so a reset leaves no trace', () => {
    expect(A.normalizeAccent('#E14775')).toBe('');
    expect(A.normalizeAccent('#abc')).toBe('#aabbcc');
    expect(A.normalizeAccent('nonsense')).toBe('');
    expect(A.normalizeAccent(undefined)).toBe('');
  });
});

describe('contrast, ink and fill', () => {
  it('measures WCAG contrast', () => {
    expect(A.contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(A.contrast('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(A.contrast('#e14775', '#ffffff')).toBeCloseTo(3.92, 1);
  });

  it('picks white ink unless dark ink is clearly better, per Monokai Pro Light preset', () => {
    const ink = Object.fromEntries(
      A.ACCENT_PRESETS.map((p) => [p.id, A.inkFor(p.hex) === A.INK_LIGHT ? 'light' : 'dark'])
    );
    expect(ink).toEqual({
      pink: 'light',
      orange: 'dark',
      yellow: 'dark',
      green: 'dark',
      blue: 'light',
      purple: 'light',
    });
  });

  it('gives every preset and the default a fill its ink holds 4.5:1 on (PRODUCT.md)', () => {
    for (const p of A.ACCENT_PRESETS) {
      const fill = A.fillFor(p.hex);
      expect(A.contrast(fill, A.inkFor(p.hex)), p.id).toBeGreaterThanOrEqual(A.MIN_INK_CONTRAST);
    }
  });

  it('holds 4.5:1 for any colour: a sweep of the RGB cube', () => {
    const steps = [0, 51, 102, 153, 204, 255];
    const worst: string[] = [];
    for (const r of steps)
      for (const g of steps)
        for (const b of steps) {
          const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
          if (A.contrast(A.fillFor(hex), A.inkFor(hex)) < A.MIN_INK_CONTRAST) worst.push(hex);
        }
    expect(worst).toEqual([]);
  });

  it('leaves an accent alone when its ink already reads', () => {
    expect(A.fillFor('#7058be')).toBe('#7058be');
    expect(A.fillFor('#cc7a0a')).toBe('#cc7a0a');
  });

  it('only darkens for light ink and only lightens for dark ink', () => {
    expect(A.luminance(A.fillFor('#e14775'))).toBeLessThan(A.luminance('#e14775'));
    expect(A.luminance(A.fillFor('#1c8ca8'))).toBeLessThan(A.luminance('#1c8ca8'));
    // A mid grey the 1.2 bias hands to white ink: darkened until it holds.
    expect(A.inkFor('#808080')).toBe(A.INK_LIGHT);
    expect(A.luminance(A.fillFor('#808080'))).toBeLessThan(A.luminance('#808080'));
  });

  it('answers for the default accent too: the skin literal IS the helper result', () => {
    const skin = STYLES.match(/html\[data-skin="monokai-pro-light"\] \{[\s\S]*?\n\}/)![0];
    const fill = A.fillFor(A.DEFAULT_ACCENT);
    expect(fill).toBe('#cf416c');
    expect(skin).toContain(`--accent-fill: ${fill};`);
    expect(skin).toContain(`--accent-grad-a: ${fill}; --accent-grad-b: ${fill};`);
    // The skin's own white ink on it passes where the raw #e14775 (3.9:1) did not.
    expect(skin).toContain('--accent-ink: #ffffff;');
    expect(A.contrast(fill, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(A.contrast(A.DEFAULT_ACCENT, '#ffffff')).toBeLessThan(4.5);
  });
});

describe('planAppearance', () => {
  it('is empty for the defaults: every var removed, no data-accent', () => {
    const plan = A.plan({});
    expect(plan.accentAttr).toBeNull();
    expect(Object.values(plan.vars).every((v) => v === null)).toBe(true);
    expect(A.plan(undefined).scale).toBe(100);
    expect(A.plan('garbage').accent).toBe('');
  });

  it('turns a custom accent into the five inline tokens the stylesheet derives from', () => {
    const plan = A.plan({ accent: '#1C8CA8' });
    expect(plan.accentAttr).toBe('custom');
    expect(plan.vars['--accent']).toBe('#1c8ca8');
    expect(plan.vars['--accent-rgb']).toBe('28, 140, 168');
    expect(plan.vars['--accent-ink']).toBe(A.INK_LIGHT);
    expect(plan.vars['--accent-fill']).toBe(A.fillFor('#1c8ca8'));
    expect(plan.vars['--accent-shade']).toBe('#000');
    expect(A.plan({ accent: '#cc7a0a' }).vars['--accent-shade']).toBe('#fff');
  });

  it('maps UI size only onto the four allowed steps', () => {
    expect(A.plan({ uiScale: 125 }).vars['--ui-scale']).toBe('1.25');
    expect(A.plan({ uiScale: '90' }).vars['--ui-scale']).toBe('0.9');
    expect(A.plan({ uiScale: 110 }).vars['--ui-scale']).toBe('1.1');
    expect(A.plan({ uiScale: 100 }).vars['--ui-scale']).toBeNull();
    for (const bad of [0, 80, 130, 'big', NaN, null, {}]) expect(A.normalizeScale(bad), String(bad)).toBe(100);
  });

  it('resolves fonts by own key only, never through the prototype', () => {
    expect(A.plan({ uiFont: 'system' }).vars['--ui-font']).toBe(A.UI_FONTS.system);
    expect(A.plan({ dataFont: 'system' }).vars['--font-mono']).toBe(A.MONO_FONTS.system);
    for (const bad of ['constructor', '__proto__', 'toString', 'Comic Sans', 7, null]) {
      expect(A.plan({ uiFont: bad }).uiFont, String(bad)).toBe('default');
      expect(A.plan({ dataFont: bad }).dataFont, String(bad)).toBe('default');
    }
    // JetBrains Mono is the bundled data face; the UI list offers only faces that ship or exist everywhere.
    expect(Object.keys(A.UI_FONTS)).toEqual(['default', 'system', 'serif', 'mono']);
    expect(Object.keys(A.MONO_FONTS)).toEqual(['default', 'system']);
    expect(A.UI_FONTS.mono).toContain("'JetBrains Mono'");
  });

  it('writes and fully undoes a plan on the root element', () => {
    const root = fakeRoot();
    A.apply(A.plan({ accent: '#269d69', uiFont: 'serif', dataFont: 'system', uiScale: 125 }), root);
    expect(root.attrs.get('data-accent')).toBe('custom');
    expect(root.props.get('--accent')).toBe('#269d69');
    expect(root.props.get('--ui-scale')).toBe('1.25');
    expect(root.props.get('--ui-font')).toBe(A.UI_FONTS.serif);
    A.apply(A.plan({}), root);
    expect(root.attrs.size).toBe(0);
    expect(root.props.size).toBe(0);
  });
});

/** The inline pre-paint script: the one that reads localStorage['codeman:appearance']. */
function prePaintSource(): string {
  const scripts = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = scripts.filter((s) => s.includes("localStorage.getItem('codeman:appearance')"));
  expect(found).toHaveLength(1);
  return found[0];
}

function runPrePaint(stored: unknown, raw = false): ReturnType<typeof fakeRoot> {
  const root = fakeRoot();
  const context = vm.createContext({
    localStorage: { getItem: () => (raw ? (stored as string) : JSON.stringify(stored)) },
    document: { documentElement: root },
  });
  vm.runInContext(prePaintSource(), context);
  return root;
}

describe('the inline pre-paint script', () => {
  it('sits before the language script, with the skin script, ahead of any stylesheet paint', () => {
    expect(INDEX.indexOf("localStorage.getItem('codeman:appearance')")).toBeGreaterThan(
      INDEX.indexOf("localStorage.getItem('codeman:skin')")
    );
    expect(INDEX.indexOf("localStorage.getItem('codeman:appearance')")).toBeLessThan(
      INDEX.indexOf("JSON.parse(localStorage.getItem(k)||'{}').language")
    );
  });

  it('reads the same key applyAppearance() writes', () => {
    expect(A).toBeTruthy();
    expect(CONSTANTS).toContain("const APPEARANCE_STORAGE_KEY = 'codeman:appearance';");
  });

  const cases: Record<string, unknown>[] = [
    {},
    { accent: '#1c8ca8', uiFont: 'system', dataFont: 'system', uiScale: 125 },
    { accent: '#cc7a0a', uiScale: 90 },
    { accent: '#e16032', uiFont: 'serif' },
    { accent: '#269d69', uiFont: 'mono', uiScale: 110 },
    { accent: '#7058be' },
    { accent: '#808080' },
    { accent: '#ffffff' },
    { accent: '#000000' },
    { accent: '#e14775', uiScale: 100 },
    { accent: '#fff', uiFont: 'constructor', dataFont: '__proto__', uiScale: 80 },
    { accent: 'red; background:url(x)' },
  ];
  for (const stored of cases) {
    it(`paints what the plan says for ${JSON.stringify(stored)}`, () => {
      // applyAppearance() stores the normalized plan; the pre-paint script is handed exactly that.
      const plan = A.plan(stored);
      const normalized = { accent: plan.accent, uiFont: plan.uiFont, dataFont: plan.dataFont, uiScale: plan.scale };
      const root = runPrePaint(normalized);
      const expected = new Map(Object.entries(plan.vars).filter(([, v]) => v !== null) as [string, string][]);
      expect(Object.fromEntries(root.props)).toEqual(Object.fromEntries(expected));
      expect(root.attrs.get('data-accent') ?? null).toBe(plan.accentAttr);
    });
  }

  it('paints nothing, and does not throw, for a missing or corrupt value', () => {
    expect(runPrePaint(null, true).props.size).toBe(0);
    expect(runPrePaint('{not json', true).props.size).toBe(0);
    expect(runPrePaint('[]', true).props.size).toBe(0);
  });
});

/** Strip comments and strings so braces in them do not count. */
function braceBalance(css: string): number {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  let depth = 0;
  for (const ch of bare) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  return depth;
}

describe('the stylesheet', () => {
  it('keeps its braces balanced', () => {
    expect(braceBalance(STYLES)).toBe(0);
    expect(braceBalance(MOBILE)).toBe(0);
    expect(braceBalance(CHAT)).toBe(0);
  });

  it('multiplies every --fs-* step by --ui-scale and starts at 1', () => {
    const root = STYLES.match(/:root \{[\s\S]*?\n\}/)![0];
    expect(root).toContain('--ui-scale: 1;');
    for (const step of ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl']) {
      expect(root, step).toMatch(new RegExp(`--fs-${step}: calc\\(\\d+px \\* var\\(--ui-scale\\)\\);`));
    }
  });

  it('scales the chrome heights, the workbench skin and the phone header included', () => {
    expect(STYLES).toContain('--header-height: calc(36px * var(--ui-scale));');
    expect(STYLES).toContain('--toolbar-height: calc(42px * var(--ui-scale));');
    expect(STYLES).toContain('--toolbar-height: calc(32px * var(--ui-scale));');
    expect(MOBILE).toContain('--header-height: calc(44px * var(--ui-scale, 1));');
  });

  it('keeps the terminal out of the UI size: the IME preview and the iOS zoom guard do not scale', () => {
    expect(STYLES).toContain('font-size: calc(var(--fs-md) / var(--ui-scale, 1));');
    expect(STYLES).toContain(
      'font-size: 16px !important; /* prevent iOS auto-zoom on focus; deliberately not scaled */'
    );
    // Any rule on xterm's own elements that reads the scale must divide it back out.
    const scaled = [...STYLES.matchAll(/([^{}]*\.xterm[^{}]*)\{([^{}]*)\}/g)].filter((m) => /var\(--fs-/.test(m[2]));
    for (const m of scaled) expect(m[2], m[1].trim()).toContain('/ var(--ui-scale, 1)');
  });

  it('derives every accent token from the inline accent with color-mix, after all skin blocks', () => {
    const at = STYLES.indexOf('html[data-accent] {');
    expect(at).toBeGreaterThan(-1);
    const block = STYLES.slice(at, STYLES.indexOf('\n}', at));
    for (const token of [
      '--accent-hover',
      '--accent-d',
      '--accent-grad-a',
      '--accent-grad-b',
      '--run-hover-a',
      '--run-hover-b',
      '--gear-hover',
    ]) {
      expect(block, token).toContain(`${token}:`);
    }
    expect(block).toContain('color-mix(in srgb, var(--accent-fill) 86%, var(--accent-shade))');
    // Equal specificity with html[data-skin=...]: it only wins by coming last.
    const lastSkinBlock = Math.max(...[...STYLES.matchAll(/^html\[data-skin="[a-z-]+"\] \{/gm)].map((m) => m.index!));
    const firstSkinBlockAfter = [...STYLES.matchAll(/^html\[data-skin="[a-z-]+"\] \{/gm)]
      .map((m) => m.index!)
      .filter((i) => i > at);
    // The only later skin-token block is the workbench layout block, which defines sizes, not accent tokens.
    for (const i of firstSkinBlockAfter) {
      const later = STYLES.slice(i, STYLES.indexOf('\n}', i));
      expect(later).not.toMatch(/--accent(-hover|-d|-grad-[ab])?:|--run-hover|--gear-hover/);
    }
    expect(lastSkinBlock).toBeGreaterThan(0);
  });

  it('defines the fill and shade defaults so a skin with no override follows its own accent', () => {
    expect(STYLES).toContain('--accent-fill: var(--accent);');
    expect(STYLES).toContain('--accent-shade: #000;');
  });

  it('never paints a label in a fixed light/accent ink over the raw accent again', () => {
    // A rule with background var(--accent) and color white/#fff/accent-ink, but no accent-fill: the 3.9:1 case.
    const offenders: string[] = [];
    for (const [file, css] of [
      ['styles.css', STYLES],
      ['mobile.css', MOBILE],
      ['chat.css', CHAT],
    ] as const) {
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const body = m[2];
        const raw = /background(?:-color)?:\s*var\(--accent\)\s*(?:!important)?;/.test(body);
        const ink = /(?<![-\w])color:\s*(?:white|#fff|var\(--accent-ink(?:,\s*#fff)?\))\s*(?:!important)?;/.test(body);
        if (raw && ink) offenders.push(`${file}: ${m[1].trim().split('\n').pop()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the settings contract', () => {
  const KEYS = ['accentColor', 'uiFont', 'dataFont', 'uiScale'];

  it('is per-device: displayKeys yes, SettingsUpdateSchema no, stripped from the settings PUT', () => {
    const start = SETTINGS_UI.indexOf('const displayKeys = new Set([');
    const displayBlock = SETTINGS_UI.slice(start, SETTINGS_UI.indexOf(']);', start));
    for (const key of KEYS) {
      expect(displayBlock, key).toContain(`'${key}'`);
      // .strict(): an undeclared key is a 400 for the whole PUT, which is why it is stripped.
      expect(SettingsUpdateSchema.safeParse({ [key]: key === 'uiScale' ? 110 : 'x' }).success, key).toBe(false);
      expect(SETTINGS_UI, key).toMatch(new RegExp(`${key}: _\\w+,`));
    }
  });

  it('loads, saves and applies the controls by id', () => {
    for (const id of [
      'appSettingsAccent',
      'appSettingsAccentCustom',
      'appSettingsAccentPicker',
      'appSettingsAccentChip',
      'appSettingsAccentNote',
      'appSettingsUiFont',
      'appSettingsDataFont',
      'appSettingsUiScale',
    ]) {
      expect(INDEX, id).toContain(`id="${id}"`);
      expect(SETTINGS_UI, id).toContain(`'${id}'`);
    }
    expect(SETTINGS_UI).toContain('this._loadAppearanceControls(settings);');
    expect(SETTINGS_UI).toContain('...this._readAppearanceControls(),');
    // Applied live on save and at boot (twice: before and after the server settings merge).
    expect(SETTINGS_UI).toMatch(/this\.applySkin\(\);\n\s+this\.applyAppearance\(\);/);
    expect((read('app.js').match(/this\.applyAppearance\(\);/g) ?? []).length).toBe(2);
  });

  it('offers the four sizes, the bundled faces and the six Monokai Pro Light accents', () => {
    const scale = INDEX.match(/id="appSettingsUiScale"[\s\S]*?<\/select>/)![0];
    expect([...scale.matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(A.SCALES);
    const swatches = [...INDEX.matchAll(/class="set-accent-swatch"[^>]*data-accent="(#[0-9a-f]{6})"/g)].map(
      (m) => m[1]
    );
    expect(swatches).toEqual(A.ACCENT_PRESETS.map((p) => p.hex));
    expect(swatches[0]).toBe(A.DEFAULT_ACCENT);
    const ui = INDEX.match(/id="appSettingsUiFont"[\s\S]*?<\/select>/)![0];
    expect([...ui.matchAll(/<option value="(\w+)"/g)].map((m) => m[1])).toEqual(Object.keys(A.UI_FONTS));
    const mono = INDEX.match(/id="appSettingsDataFont"[\s\S]*?<\/select>/)![0];
    expect([...mono.matchAll(/<option value="(\w+)"/g)].map((m) => m[1])).toEqual(Object.keys(A.MONO_FONTS));
  });

  it('lives in the Appearance section as a device-scoped group', () => {
    const section = INDEX.match(/id="settings-appearance"[\s\S]*?<\/section>/)![0];
    const group = section.match(/<h4>Look<\/h4><span class="set-scope">device<\/span>[\s\S]*?<h4>Identity<\/h4>/);
    expect(group).toBeTruthy();
    expect(group![0]).toContain('id="appSettingsUiScale"');
  });

  it('wraps under its label on a phone', () => {
    expect(MOBILE).toMatch(/\.set-accent \{\s*align-items: flex-start;/);
    expect(STYLES).toMatch(/\.set-accent-swatches \{[^}]*flex-wrap: wrap;/);
  });
});

const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
type Api = { t(s: string): string; configure(o: Record<string, string>): void; start(): void };
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.start();
afterAll(() => dom.window.close());

describe('zh-CN', () => {
  const STRINGS = [
    'Look',
    'Accent Colour',
    'Buttons, selection and focus. The text on it switches to dark or light so it stays readable.',
    'Pink (default)',
    'Orange',
    'Yellow',
    'Green',
    'Blue',
    'Purple',
    'Custom colour',
    'Custom accent colour',
    'Low contrast with the background',
    'Interface Font',
    'Menus, tabs and dialogs. The terminal keeps its own font.',
    'Manrope (default)',
    'System UI',
    'Serif',
    'Monospace',
    'Data Font',
    'Paths, ids, counts and code in the interface.',
    'JetBrains Mono (default)',
    'System monospace',
    'Interface Size',
    'Scales the interface text and bars. The terminal font size is set separately.',
    '100% (default)',
  ];

  it('translates every new string, and each key is in the dictionary once', () => {
    api.configure({ language: 'zh-CN' });
    expect(STRINGS.filter((s) => api.t(s) === s)).toEqual([]);
    const repeated = STRINGS.filter((s) => {
      const key = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return (I18N.match(new RegExp(`^\\s*(?:'${key}'|"${key}"|${key}):`, 'gm')) ?? []).length !== 1;
    });
    expect(repeated).toEqual([]);
  });

  it('translates the contrast note the picker writes', () => {
    api.configure({ language: 'zh-CN' });
    expect(api.t('Label text: light ink, 4.5:1')).toBe('标签文字：浅色文字，4.5:1');
    expect(api.t('Label text: dark ink, 5.1:1')).toBe('标签文字：深色文字，5.1:1');
  });

  it('shows every visible string of the group in the document: all of them are in the page', () => {
    for (const s of STRINGS) {
      const inHtml = INDEX.includes(`>${s}<`) || INDEX.includes(`title="${s}"`) || INDEX.includes(`aria-label="${s}"`);
      const inJs = SETTINGS_UI.includes(s);
      expect(inHtml || inJs, s).toBe(true);
    }
  });

  it('reads exactly as before in English', () => {
    api.configure({ language: 'en' });
    expect(STRINGS.filter((s) => api.t(s) !== s)).toEqual([]);
  });
});
