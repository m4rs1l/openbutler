import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Write authority for configuration: a store earns it by being loaded from
 * disk, and a store that was never loaded may only CREATE the files — never
 * replace them. The revision check already refuses a loaded store whose disk
 * moved; this covers the other half, where there is no revision to compare:
 * a fresh defaults object silently destroying settings.yaml and the provider
 * keys in config.yaml (the 2026-11-15 wipe).
 */
const root = mkdtempSync(join(tmpdir(), 'ob-settings-guard-'));
vi.stubEnv('OPENBUTLER_DATA_DIR', root);

const settingsPath = join(root, 'settings.yaml');
const configPath = join(root, 'config.yaml');

function clearFiles(): void {
  rmSync(settingsPath, { force: true });
  rmSync(configPath, { force: true });
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('settings write authority', () => {
  it('refuses a never-loaded store when the files exist, byte-for-byte', async () => {
    const { defaultSettings, saveSettings } = await import('../src/settings.js');
    clearFiles();
    const settingsBefore = 'approvalMode: full-access\nschedules: []\n';
    const configBefore = 'providers:\n  vercel:\n    keys:\n      - stored-key\n';
    writeFileSync(settingsPath, settingsBefore, 'utf8');
    writeFileSync(configPath, configBefore, 'utf8');

    expect(() => saveSettings(defaultSettings())).toThrow(/never loaded/);

    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  });

  it('refuses when only the secret store exists, so keys cannot be dropped either', async () => {
    const { defaultSettings, saveSettings } = await import('../src/settings.js');
    clearFiles();
    const configBefore = 'providers:\n  vercel:\n    keys:\n      - stored-key\n';
    writeFileSync(configPath, configBefore, 'utf8');

    expect(() => saveSettings(defaultSettings())).toThrow(/never loaded/);

    expect(existsSync(settingsPath)).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
  });

  it('still lets a fresh store create an empty machine', async () => {
    const { defaultSettings, saveSettings } = await import('../src/settings.js');
    clearFiles();
    const store = defaultSettings();
    store.defaultModel = 'created-by-this-store';
    saveSettings(store);
    expect(readFileSync(settingsPath, 'utf8')).toContain('created-by-this-store');
  });

  it('lets the blessed flow work: load, change the loaded store, save over the file', async () => {
    const { loadSettings, saveSettings } = await import('../src/settings.js');
    clearFiles();
    writeFileSync(settingsPath, 'approvalMode: full-access\ndefaultModel: before\n', 'utf8');
    const store = loadSettings();
    store.defaultModel = 'after';
    saveSettings(store);
    const reloaded = loadSettings();
    expect(reloaded.defaultModel).toBe('after');
    expect(reloaded.approvalMode).toBe('full-access');
  });

  it('keeps the stale-copy refusal for a loaded store whose disk moved', async () => {
    const { loadSettings, saveSettings } = await import('../src/settings.js');
    clearFiles();
    writeFileSync(settingsPath, 'defaultModel: original\n', 'utf8');
    const store = loadSettings();
    // Another writer commits in between; this copy no longer describes the disk.
    writeFileSync(settingsPath, 'defaultModel: other-writer\n', 'utf8');
    store.defaultModel = 'mine';
    expect(() => saveSettings(store)).toThrow(/changed after this copy was loaded/);
    expect(readFileSync(settingsPath, 'utf8')).toContain('other-writer');
  });
});
