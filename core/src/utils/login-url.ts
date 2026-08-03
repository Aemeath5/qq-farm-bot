export {};

export interface LoginClientHints {
    platform: string;
    os: string;
    ver: string;
}

const FALLBACK_GATE_HOST = 'gate-obt.nqf.qq.com';

function toHref(rawInput: string): string {
    const raw = String(rawInput || '').trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    if (raw.startsWith('/') || raw.includes('?')) {
        return `wss://${FALLBACK_GATE_HOST}${raw.startsWith('/') ? raw : `/${raw}`}`;
    }
    if (/[?&](?:platform|os|ver|code)=/i.test(raw)) {
        return `wss://${FALLBACK_GATE_HOST}/prod/ws?${raw.replace(/^\?/, '')}`;
    }
    return '';
}

function decodeParam(value: string | null | undefined): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/**
 * 从完整 WS/HTTP 登录 URL 或裸 code 中提取登录 code。
 */
function extractCode(rawInput: unknown): string {
    const raw = String(rawInput || '').trim();
    if (!raw) return '';

    try {
        const href = toHref(raw);
        if (href) {
            const code = new URL(href).searchParams.get('code');
            if (code) return decodeParam(code);
        }
    } catch {
        // fall through
    }

    const match = raw.match(/[?&]code=([^&\s#]+)/i);
    if (match && match[1]) return decodeParam(match[1]);

    if (!/[\s/?&=]/.test(raw)) return raw;
    return '';
}

/**
 * 从完整登录 URL 中提取 platform / os / ver。
 */
function extractClientHints(rawInput: unknown): LoginClientHints {
    const raw = String(rawInput || '').trim();
    const hints: LoginClientHints = { platform: '', os: '', ver: '' };
    if (!raw || !/[?&]/.test(raw)) return hints;

    try {
        const href = toHref(raw);
        if (href) {
            const url = new URL(href);
            hints.platform = decodeParam(url.searchParams.get('platform')).toLowerCase();
            hints.os = decodeParam(url.searchParams.get('os'));
            hints.ver = decodeParam(url.searchParams.get('ver'));
            return hints;
        }
    } catch {
        // fall through to regex
    }

    const platform = raw.match(/[?&]platform=([^&\s#]+)/i);
    const os = raw.match(/[?&]os=([^&\s#]+)/i);
    const ver = raw.match(/[?&]ver=([^&\s#]+)/i);
    if (platform) hints.platform = decodeParam(platform[1]).toLowerCase();
    if (os) hints.os = decodeParam(os[1]);
    if (ver) hints.ver = decodeParam(ver[1]);
    return hints;
}

function normalizeLoginPlatform(platform: unknown): 'qq' | 'wx' | '' {
    const value = String(platform || '').trim().toLowerCase();
    if (value === 'qq' || value === 'wx') return value;
    return '';
}

module.exports = {
    extractCode,
    extractClientHints,
    normalizeLoginPlatform,
};
