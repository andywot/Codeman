import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type SizeHelper = {
  defaultSize: (deviceType?: string) => number;
  savedSize: (storage: Storage, deviceType?: string) => number | null;
};

function loadHelper(): SizeHelper {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanTerminalFont: SizeHelper }).CodemanTerminalFont;
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const font = loadHelper();

describe('terminal font size defaults', () => {
  it('defaults phones to 13 and everything else to 15', () => {
    expect(font.defaultSize('mobile')).toBe(13);
    expect(font.defaultSize('desktop')).toBe(15);
    expect(font.defaultSize(undefined)).toBe(15);
  });

  it('drops a saved size below the default once, then keeps whatever the user picks', () => {
    const storage = memoryStorage({ 'codeman-font-size': '10' });
    expect(font.savedSize(storage, 'mobile')).toBeNull();
    expect(storage.getItem('codeman-font-size')).toBeNull();
    storage.setItem('codeman-font-size', '11');
    expect(font.savedSize(storage, 'mobile')).toBe(11);
  });

  it('keeps a saved size at or above the default', () => {
    expect(font.savedSize(memoryStorage({ 'codeman-font-size': '18' }), 'desktop')).toBe(18);
    expect(font.savedSize(memoryStorage({ 'codeman-font-size': '13' }), 'mobile')).toBe(13);
  });

  it('ignores out-of-range or junk values', () => {
    expect(font.savedSize(memoryStorage({ 'codeman-font-size': '40' }), 'desktop')).toBeNull();
    expect(font.savedSize(memoryStorage({ 'codeman-font-size': 'big' }), 'desktop')).toBeNull();
    expect(font.savedSize(memoryStorage(), 'desktop')).toBeNull();
  });
});
