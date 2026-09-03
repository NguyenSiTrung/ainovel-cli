/**
 * Locale catalog tests: every key present in all three tables (en/vi/zh),
 * English fallback for unknown keys, and locale switching via setLocale.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';

import { currentLanguage, localeTables, setLocale, t } from '$lib/locale';

beforeEach(() => {
  setLocale('en');
});

describe('locale catalog', () => {
  it('every key is present in all three tables', () => {
    const keys = Object.keys(localeTables.en);
    expect(keys.length).toBeGreaterThan(0);
    for (const lang of ['vi', 'zh'] as const) {
      for (const key of keys) {
        expect(localeTables[lang][key], `${lang} missing ${key}`).toBeDefined();
        expect(typeof localeTables[lang][key]).toBe('string');
      }
    }
    // No table carries keys the English reference lacks.
    for (const lang of ['vi', 'zh'] as const) {
      for (const key of Object.keys(localeTables[lang])) {
        expect(keys, `${lang} has extra ${key}`).toContain(key);
      }
    }
  });

  it('falls back to English for unknown keys and unsupported languages', () => {
    expect(t('no.such.key')).toBe('no.such.key');
    expect(t('route.overview.label', 'xx')).toBe(localeTables.en['route.overview.label']);
    expect(t('route.overview.label', '  ')).toBe(localeTables.en['route.overview.label']);
  });

  it('setLocale adopts engine codes and ignores unknown ones', () => {
    expect(setLocale(' vi ')).toBe('vi');
    expect(get(currentLanguage)).toBe('vi');
    expect(t('route.overview.label')).toBe(localeTables.vi['route.overview.label']);
    expect(setLocale('xx')).toBe('vi');
    expect(get(currentLanguage)).toBe('vi');
    expect(setLocale('ZH')).toBe('zh');
    expect(get(currentLanguage)).toBe('zh');
  });
});
