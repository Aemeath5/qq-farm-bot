export {};

/**
 * 将登录 URL 中的 platform/os/ver 写入全局系统配置并热更新运行时 CONFIG。
 */

const store = require('../models/store');
const { updateRuntimeConfig, getRuntimeConfig, getDevicePresets } = require('../config/config');
const { normalizeLoginPlatform } = require('../utils/login-url');

function findDevicePresetByOs(os: string): any | null {
    const needle = String(os || '').trim().toLowerCase();
    if (!needle) return null;
    const presets = getDevicePresets() || [];
    const aliases: Record<string, string[]> = {
        windows: ['windows', 'win'],
        ios: ['ios', 'iphone', 'ipad'],
        android: ['android'],
        'os x': ['os x', 'osx', 'mac', 'macos', 'mac os', 'mac os x'],
    };

    for (const preset of presets) {
        const presetOs = String(preset?.deviceInfo?.os || preset?.os || '').trim().toLowerCase();
        if (!presetOs) continue;
        if (presetOs === needle) return preset;
        for (const [canon, list] of Object.entries(aliases)) {
            if (list.includes(needle) && (presetOs === canon || list.includes(presetOs))) {
                return preset;
            }
        }
    }
    return null;
}

function applyLoginClientHintsToSystemConfig(hints: { platform?: string; os?: string; ver?: string } | null | undefined): Record<string, any> | null {
    if (!hints || typeof hints !== 'object') return null;

    const platform = normalizeLoginPlatform(hints.platform);
    const os = String(hints.os || '').trim();
    const ver = String(hints.ver || '').trim();
    const hasVer = !!ver && /^[\w.-]+$/.test(ver) && ver.length > 4;
    if (!platform && !os && !hasVer) return null;

    const current = store.getSystemConfig() || getRuntimeConfig() || {};
    const currentDevice = (current.deviceInfo && typeof current.deviceInfo === 'object')
        ? { ...current.deviceInfo }
        : {};

    let nextDevice = { ...currentDevice };
    if (os) {
        const preset = findDevicePresetByOs(os);
        if (preset && preset.deviceInfo) {
            nextDevice = {
                ...nextDevice,
                ...preset.deviceInfo,
                // URL 原始 os 优先（例如 OS X），保留游戏侧字面量
                os,
            };
        } else {
            nextDevice = {
                ...nextDevice,
                os,
                sysSoftware: nextDevice.sysSoftware || os,
            };
        }
    }

    if (hasVer) {
        nextDevice.clientVersion = ver;
    }

    const nextConfig = {
        ...current,
        platform: platform || current.platform || 'qq',
        os: os || current.os || nextDevice.os || 'Windows',
        clientVersion: hasVer ? ver : (current.clientVersion || nextDevice.clientVersion || ''),
        deviceInfo: {
            ...nextDevice,
            os: os || nextDevice.os || current.os || 'Windows',
            clientVersion: hasVer ? ver : (nextDevice.clientVersion || current.clientVersion || ''),
        },
    };

    const saved = store.setSystemConfig(nextConfig);
    if (saved) updateRuntimeConfig(saved);
    return saved;
}

module.exports = {
    applyLoginClientHintsToSystemConfig,
    findDevicePresetByOs,
};
