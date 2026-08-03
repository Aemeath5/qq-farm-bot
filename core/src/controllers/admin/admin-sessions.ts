export {};
/**
 * 管理端登录会话持久化：重启后恢复 token，避免反复输账号密码。
 * 只存 token→username，用户详情每次从 users.json 现取。
 */
import type { AdminContext } from './context';

const fs = require('node:fs');
const { getDataFile, ensureDataDir } = require('../../config/runtime-paths');
const userStore = require('../../models/user-store');
const { createModuleLogger } = require('../../services/logger');

const adminLogger = createModuleLogger('admin');
const SESSIONS_FILE: string = getDataFile('admin-sessions.json');
/** 会话最长保留 30 天 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface PersistedSession {
    token: string;
    username: string;
    issuedAt: number;
}

interface SessionsFile {
    sessions: PersistedSession[];
}

function readSessionsFile(): PersistedSession[] {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return [];
        const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) as SessionsFile;
        return Array.isArray(raw?.sessions) ? raw.sessions : [];
    } catch (e: any) {
        adminLogger.warn('读取管理端会话失败', { error: e?.message || String(e) });
        return [];
    }
}

function writeSessionsFile(sessions: PersistedSession[]): void {
    try {
        ensureDataDir();
        const payload: SessionsFile = { sessions };
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e: any) {
        adminLogger.warn('保存管理端会话失败', { error: e?.message || String(e) });
    }
}

function snapshotFromCtx(ctx: AdminContext): PersistedSession[] {
    const now = Date.now();
    const existing = new Map(readSessionsFile().map((s) => [s.token, s]));
    const out: PersistedSession[] = [];
    for (const token of ctx.tokens) {
        const user = ctx.tokenUserMap.get(token);
        const username = String(user?.username || '').trim();
        if (!username) continue;
        const prev = existing.get(token);
        const issuedAt = prev?.issuedAt || now;
        if (now - issuedAt > SESSION_TTL_MS) continue;
        out.push({ token, username, issuedAt });
    }
    return out;
}

function persistSessions(ctx: AdminContext): void {
    writeSessionsFile(snapshotFromCtx(ctx));
}

function bindSession(ctx: AdminContext, token: string, user: any): void {
    if (!token || !user) return;
    ctx.tokens.add(token);
    ctx.tokenUserMap.set(token, user);
    persistSessions(ctx);
}

function unbindSession(ctx: AdminContext, token: string): void {
    if (!token) return;
    ctx.tokens.delete(token);
    ctx.tokenUserMap.delete(token);
    persistSessions(ctx);
}

function loadPersistedSessions(ctx: AdminContext): number {
    const now = Date.now();
    const saved = readSessionsFile();
    let restored = 0;
    const kept: PersistedSession[] = [];

    for (const item of saved) {
        const token = String(item?.token || '').trim();
        const username = String(item?.username || '').trim();
        const issuedAt = Number(item?.issuedAt) || 0;
        if (!token || !username) continue;
        if (!issuedAt || now - issuedAt > SESSION_TTL_MS) continue;

        const user = userStore.getSessionUser(username);
        if (!user) continue;

        // 普通用户仍需检查封禁/过期
        if (user.role !== 'admin' && user.card) {
            if (user.card.enabled === false) continue;
            if (user.card.expiresAt && user.card.expiresAt < now) continue;
        }

        ctx.tokens.add(token);
        ctx.tokenUserMap.set(token, user);
        kept.push({ token, username, issuedAt });
        restored += 1;
    }

    writeSessionsFile(kept);
    if (restored > 0) {
        adminLogger.info('已恢复管理端登录会话', { count: restored });
    }
    return restored;
}

module.exports = {
    bindSession,
    unbindSession,
    persistSessions,
    loadPersistedSessions,
};
