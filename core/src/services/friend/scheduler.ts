/**
 * 好友巡查调度 - 循环管理、每日重置、经验限制、自动接受好友、启动捣乱
 */

const { CONFIG } = require('../../config/config');
const { getUserState, networkEvents } = require('../../utils/network');
const { toNum, getServerTimeSec, log, logWarn, randomDelay } = require('../../utils/utils');
const { createScheduler } = require('../scheduler');
const { setOperationLimitsCallback } = require('../farm');
const {
    isAutomationOn,
    getFriendBlacklist,
} = require('../../models/store');
const { sellAllFruits } = require('../warehouse');
const {
    getAllFriends,
    acceptFriends,
    getApplications,
} = require('./api');
const {
    extractReplyFriends,
    clearAllInvalidKnownFriendGidCooldowns,
} = require('./gid-manager');
const {
    visitFriend,
    visitFriendForSteal,
    visitFriendForHelp,
    inFriendQuietHours,
    clearFriendsListCache,
} = require('./visit-strategy');

// ============ 内部状态 ============
let isCheckingFriends: boolean = false;
let friendLoopRunning: boolean = false;
let externalSchedulerMode: boolean = false;
let lastResetDate: string = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler: any = createScheduler('friend');

const operationLimits: Map<number, any> = new Map();

let canGetHelpExp: boolean = true;
let helpAutoDisabledByLimit: boolean = false;
let badExecutedOnStartup: boolean = false;
let badOperationLimitReached: boolean = false;

/**
 * 偷菜/帮助巡查：气泡（steal_plant_num 等）优先，同时轮巡气泡为 0 的好友。
 * 好友一多时服务端气泡常滞后，两种方式并存，不能只靠气泡。
 * 每轮轮巡数量 = 好友量的 1/4（至少 1）；已巡查写入 Set，扫完全员后清空。
 */
const stealPatrolVisited = new Set<number>();
const helpPatrolVisited = new Set<number>();

/** 上一轮好友气泡快照：gid -> { steal, dry, weed, insect, name } */
const lastFriendBubbleSnapshot = new Map<number, { steal: number; dry: number; weed: number; insect: number; name: string }>();

function formatBubbleDelta(label: string, curr: number, prev: number): string | null {
    if (curr === prev) return null;
    if (prev === 0 && curr > 0) return `${label}${curr}(+${curr})`;
    if (curr === 0 && prev > 0) return `${label}清零`;
    const delta = curr - prev;
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    return `${label}${curr}(${sign})`;
}

function logFriendBubbleDiff(friends: any[], myGid: number, blacklist: Set<number>): void {
    const nextSnapshot = new Map<number, { steal: number; dry: number; weed: number; insect: number; name: string }>();
    const changes: string[] = [];
    const seen = new Set<number>();

    for (const f of friends || []) {
        const gid = toNum(f && f.gid);
        if (!gid || gid === myGid || blacklist.has(gid) || seen.has(gid)) continue;
        seen.add(gid);
        const name = (f && (f.remark || f.name)) || `GID:${gid}`;
        const p = f && f.plant;
        const steal = p ? toNum(p.steal_plant_num) : 0;
        const dry = p ? toNum(p.dry_num) : 0;
        const weed = p ? toNum(p.weed_num) : 0;
        const insect = p ? toNum(p.insect_num) : 0;
        nextSnapshot.set(gid, { steal, dry, weed, insect, name });

        const prev = lastFriendBubbleSnapshot.get(gid);
        if (!prev) {
            // 首次快照不刷屏；仅当本轮已有历史时才记「新增」
            if (lastFriendBubbleSnapshot.size === 0) continue;
            const parts: string[] = [];
            if (steal > 0) parts.push(`可偷${steal}`);
            if (dry > 0) parts.push(`干旱${dry}`);
            if (weed > 0) parts.push(`草${weed}`);
            if (insect > 0) parts.push(`虫${insect}`);
            if (parts.length > 0) changes.push(`${name} ${parts.join('')}`);
            continue;
        }

        const parts = [
            formatBubbleDelta('可偷', steal, prev.steal),
            formatBubbleDelta('干旱', dry, prev.dry),
            formatBubbleDelta('草', weed, prev.weed),
            formatBubbleDelta('虫', insect, prev.insect),
        ].filter(Boolean) as string[];
        if (parts.length > 0) changes.push(`${name} ${parts.join('')}`);
    }

    // 从列表消失且上次有气泡的好友
    if (lastFriendBubbleSnapshot.size > 0) {
        for (const [gid, prev] of lastFriendBubbleSnapshot.entries()) {
            if (nextSnapshot.has(gid)) continue;
            if (prev.steal > 0 || prev.dry > 0 || prev.weed > 0 || prev.insect > 0) {
                changes.push(`${prev.name} 气泡消失`);
            }
        }
    }

    lastFriendBubbleSnapshot.clear();
    for (const [gid, snap] of nextSnapshot.entries()) {
        lastFriendBubbleSnapshot.set(gid, snap);
    }

    if (changes.length === 0) return;
    const preview = changes.slice(0, 12).join('; ');
    const more = changes.length > 12 ? ` 等${changes.length}人` : '';
    log('好友', `气泡更新: ${preview}${more}`, {
        module: 'friend',
        event: '好友气泡',
        result: 'ok',
        count: changes.length,
    });
}

/** 每轮轮巡数量：好友量的四分之一（向上取整，至少 1） */
function getPatrolBatchSize(friendCount: number): number {
    const count = Math.max(0, Number(friendCount) || 0);
    if (count <= 0) return 0;
    return Math.max(1, Math.ceil(count / 4));
}

function markPatrolVisited(kind: 'steal' | 'help', friendGid: number): void {
    const gid = toNum(friendGid);
    if (!gid) return;
    if (kind === 'steal') stealPatrolVisited.add(gid);
    else helpPatrolVisited.add(gid);
}

function clearPatrolVisited(kind?: 'steal' | 'help'): void {
    if (!kind || kind === 'steal') stealPatrolVisited.clear();
    if (!kind || kind === 'help') helpPatrolVisited.clear();
}

/**
 * 从气泡为 0 的候选中取未标记好友；若本轮已扫完则清空标记后重新开始。
 */
function selectUnvisitedPatrol(candidates: any[], budget: number, kind: 'steal' | 'help'): any[] {
    const list = Array.isArray(candidates) ? candidates : [];
    const maxCount = Math.max(0, Number(budget) || 0);
    if (list.length === 0 || maxCount <= 0) return [];

    const visited = kind === 'steal' ? stealPatrolVisited : helpPatrolVisited;
    let unmarked = list.filter((f: any) => {
        const gid = toNum(f && f.gid);
        return gid > 0 && !visited.has(gid);
    });

    if (unmarked.length === 0) {
        visited.clear();
        unmarked = list.filter((f: any) => toNum(f && f.gid) > 0);
    }

    return unmarked.slice(0, maxCount).map((friend: any) => ({ ...friend, isProbe: true }));
}

// 操作类型ID (与游戏/UI 对齐):
// 10001 = 收获, 10002 = 铲除, 10003 = 放草, 10004 = 放虫
// 10005 = 除草(帮好友), 10006 = 除虫(帮好友), 10007 = 浇水(帮好友), 10008 = 偷菜
const OP_NAMES: Record<number, string> = {
    10001: '收获',
    10002: '铲除',
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

// ============ 操作限制相关 ============

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
export function checkDailyReset(): void {
    // 使用服务器时间（北京时间 UTC+8）计算当前日期，避免时区偏差
    const nowSec: number = getServerTimeSec();
    const nowMs: number = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjOffset: number = 8 * 3600 * 1000;
    const bjDate: Date = new Date(nowMs + bjOffset);
    const y: number = bjDate.getUTCFullYear();
    const m: string = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d: string = String(bjDate.getUTCDate()).padStart(2, '0');
    const today: string = `${y}-${m}-${d}`;  // 北京时间日期 YYYY-MM-DD
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        badOperationLimitReached = false;
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }
}

export function isBadOperationLimitReached(): boolean {
    checkDailyReset();
    return badOperationLimitReached;
}

export function markBadOperationLimitReached(method: string = ''): boolean {
    checkDailyReset();
    if (badOperationLimitReached) return false;
    badOperationLimitReached = true;
    log('好友', '今日放虫/放草次数已达上限，停止两类操作', {
        module: 'friend',
        event: '放虫放草次数上限',
        result: 'limit',
        code: 1001046,
        method: String(method || ''),
    });
    return true;
}

export function autoDisableHelpByExpLimit(): void {
    if (!canGetHelpExp) return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
    });
}

/**
 * 更新操作限制状态
 */
export function updateOperationLimits(limits: any[]): void {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id: number = toNum(limit.id);
        if (id > 0) {
            const data: any = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
        }
    }
}

export function canGetExpByCandidates(opIds: number[] = []): boolean {
    const ids: number[] = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
export function canGetExp(opId: number): boolean {
    const limit: any = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
export function canOperate(opId: number): boolean {
    checkDailyReset();
    if ((opId === 10003 || opId === 10004) && badOperationLimitReached) return false;
    const limit: any = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
export function getRemainingTimes(opId: number): number {
    checkDailyReset();
    if ((opId === 10003 || opId === 10004) && badOperationLimitReached) return 0;
    const limit: any = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
export function getOperationLimits(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit: any = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}

// ============ 帮助经验状态访问器 ============

export function getCanGetHelpExp(): boolean {
    return canGetHelpExp;
}

export function setCanGetHelpExp(val: boolean): void {
    canGetHelpExp = val;
}

// ============ 好友巡查主循环 ============

interface CheckFriendsOptions {
    onlyHelp?: boolean;
    onlySteal?: boolean;
    onlyBad?: boolean;
    ignoreExpLimit?: boolean;
}

export async function checkFriends(options: CheckFriendsOptions = {}): Promise<boolean> {
    const state: any = getUserState();
    if (!isAutomationOn('friend')) return false;

    const accountId: string = process.env.FARM_ACCOUNT_ID || '';

    const helpEnabled: boolean = !!isAutomationOn('friend_help');
    const stealEnabled: boolean = !!isAutomationOn('friend_steal');
    const badEnabled: boolean = !!isAutomationOn('friend_bad');

    const onlyHelp: boolean = options.onlyHelp || false;
    const onlySteal: boolean = options.onlySteal || false;
    const onlyBad: boolean = options.onlyBad || false;
    const ignoreExpLimit: boolean = options.ignoreExpLimit || false;

    const effectiveHelpEnabled: boolean = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled: boolean = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled: boolean = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);

    const hasAnyFriendOp: boolean = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;

    isCheckingFriends = true;
    checkDailyReset();

    try {
        const friendsReply: any = await getAllFriends();
        const friends: any[] = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '好友扫描', result: 'empty' });
            return false;
        }

        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
        logFriendBubbleDiff(friends, toNum(state.gid), blacklist);

        const stealFriends: any[] = [];
        const helpFriends: any[] = [];
        const stealProbeCandidates: any[] = [];
        const helpProbeCandidates: any[] = [];
        const visitedGids: Set<number> = new Set();

        for (const f of friends) {
            const gid: number = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            if (blacklist.has(gid)) continue;

            const name: string = f.remark || f.name || `GID:${gid}`;
            const p: any = f.plant;
            const stealNum: number = p ? toNum(p.steal_plant_num) : 0;
            const dryNum: number = p ? toNum(p.dry_num) : 0;
            const weedNum: number = p ? toNum(p.weed_num) : 0;
            const insectNum: number = p ? toNum(p.insect_num) : 0;
            const needsHelp: boolean = dryNum > 0 || weedNum > 0 || insectNum > 0;

            if (stealNum > 0 && effectiveStealEnabled) {
                stealFriends.push({ gid, name, stealNum });
            } else if (effectiveStealEnabled) {
                stealProbeCandidates.push({ gid, name, stealNum: 0 });
            }

            if (needsHelp && effectiveHelpEnabled) {
                helpFriends.push({ gid, name, dryNum, weedNum, insectNum });
            } else if (effectiveHelpEnabled) {
                helpProbeCandidates.push({ gid, name, dryNum: 0, weedNum: 0, insectNum: 0 });
            }

            visitedGids.add(gid);
        }

        // 气泡优先排序
        stealFriends.sort((a: any, b: any) => b.stealNum - a.stealNum);
        helpFriends.sort((a: any, b: any) => {
            const helpA: number = a.dryNum + a.weedNum + a.insectNum;
            const helpB: number = b.dryNum + b.weedNum + b.insectNum;
            return helpB - helpA;
        });

        // 气泡 + 轮巡并存：有气泡的先处理，同时按好友量 1/4 轮巡未标记好友
        const stealFriendPoolSize: number = stealFriends.length + stealProbeCandidates.length;
        const stealPatrolBudget: number = getPatrolBatchSize(stealFriendPoolSize);
        const stealProbeFriends: any[] = effectiveStealEnabled
            ? selectUnvisitedPatrol(stealProbeCandidates, stealPatrolBudget, 'steal')
            : [];
        const stealTargets: any[] = [...stealFriends, ...stealProbeFriends];

        const helpFriendPoolSize: number = helpFriends.length + helpProbeCandidates.length;
        const helpPatrolBudget: number = getPatrolBatchSize(helpFriendPoolSize);
        const helpProbeFriends: any[] = effectiveHelpEnabled
            ? selectUnvisitedPatrol(helpProbeCandidates, helpPatrolBudget, 'help')
            : [];
        const helpTargets: any[] = [...helpFriends, ...helpProbeFriends];

        const totalActions: any = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };

        // 第二阶段：批量偷菜（气泡优先 + 轮巡）
        if (stealTargets.length > 0 && effectiveStealEnabled) {
            log('好友', `偷菜巡查：气泡 ${stealFriends.length} + 轮巡 ${stealProbeFriends.length}`, {
                module: 'friend',
                event: '开始批量偷菜',
                bubble: stealFriends.length,
                patrol: stealProbeFriends.length,
            });

            for (const friend of stealTargets) {
                if (!canOperate(10008)) break; // 偷菜次数用完

                try {
                    await visitFriendForSteal(friend, totalActions, state.gid, state.accountId);
                } catch {
                    // ignore
                }
                markPatrolVisited('steal', friend.gid);
                await randomDelay(500, 800);
            }
        }

        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await sellAllFruits();
            } catch {
                // ignore
            }
        }

        // 第三阶段：批量帮助（含气泡为 0 的抽样探测）
        if (helpTargets.length > 0 && effectiveHelpEnabled) {
            log('好友', `开始批量帮助：气泡 ${helpFriends.length} + 轮巡 ${helpProbeFriends.length}`, {
                module: 'friend', event: '开始批量帮助', count: helpFriends.length, patrol: helpProbeFriends.length
            });

            for (let i: number = 0; i < helpTargets.length; i++) {
                const friend: any = helpTargets[i];
                const label: string = friend.isProbe ? '探测帮助' : '批量帮助';
                log('好友', `${label}第 ${i + 1}/${helpTargets.length} 个好友: ${friend.name}`, {
                    module: 'friend',
                    event: friend.isProbe ? '探测帮助开始' : '批量帮助开始',
                    index: i + 1,
                    total: helpTargets.length,
                    friendName: friend.name,
                });

                // 检查是否还能获得帮助经验
                // const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
                const stopWhenExpLimit: boolean = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
                if (stopWhenExpLimit && !canGetHelpExp) {
                    log('好友', `批量帮助中断：经验已达上限`, { module: 'friend', event: '批量帮助中断', reason: 'exp_limit' });
                    break;
                }

                try {
                    await visitFriendForHelp(friend, totalActions, state.gid, state.accountId, ignoreExpLimit);
                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}`, { module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name });
                } catch (e: any) {
                    log('好友', `批量帮助第 ${i + 1} 个好友失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '批量帮助失败', index: i + 1, friendName: friend.name, error: e.message });
                }
                markPatrolVisited('help', friend.gid);
                await randomDelay(500, 800);
            }
            log('好友', '批量帮助循环结束', { module: 'friend', event: '批量帮助结束' });
        }

        // 第四阶段：批量捣乱（放虫放草）
        if (effectiveBadEnabled && !isBadOperationLimitReached()) {
            log('好友', '开始自动放虫放草', { module: 'friend', event: '开始自动放虫放草' });

            const badFriends: any[] = [];
            const badVisitedGids: Set<number> = new Set();

            for (const f of friends) {
                const gid: number = toNum(f.gid);
                if (gid === state.gid) continue;
                if (badVisitedGids.has(gid)) continue;
                if (blacklist.has(gid)) continue;

                const name: string = f.remark || f.name || `GID:${gid}`;
                const p: any = f.plant;
                const stealNum: number = p ? toNum(p.steal_plant_num) : 0;
                const dryNum: number = p ? toNum(p.dry_num) : 0;
                const weedNum: number = p ? toNum(p.weed_num) : 0;
                const insectNum: number = p ? toNum(p.insect_num) : 0;

                // 只没有可偷、可帮助的好友才考虑捣乱
                if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
                    const level: number = toNum(f.level);
                    badFriends.push({ gid, name, level });
                }

                badVisitedGids.add(gid);
            }

            // 按等级降序排序，优先处理等级高的好友
            badFriends.sort((a: any, b: any) => b.level - a.level);

            // 只取等级最高的前20个
            const topBadFriends: any[] = badFriends.slice(0, 20);

            if (topBadFriends.length > 0) {
                log('好友', `找到 ${badFriends.length} 个可捣乱的好友，处理等级最高的前${topBadFriends.length}个`, { module: 'friend', event: '放虫放草好友列表', totalCount: badFriends.length, topCount: topBadFriends.length });

                for (let i: number = 0; i < topBadFriends.length; i++) {
                    const friend: any = topBadFriends[i];
                    if (isBadOperationLimitReached()) break;

                    // 检查是否还有捣乱次数
                    const canPutBug: boolean = canOperate(10004);
                    const canPutWeed: boolean = canOperate(10003);
                    if (!canPutBug && !canPutWeed) {
                        log('好友', `放虫放草次数已用完，停止执行`, { module: 'friend', event: '放虫放草次数用完' });
                        break;
                    }

                    try {
                        await visitFriend(friend, totalActions, state.gid, state.accountId);
                    } catch (e: any) {
                        // 单个好友失败不影响整体
                    }
                    if (isBadOperationLimitReached()) break;
                    await randomDelay(2000, 3500);
                }
            }
        }

        // 生成总结日志
        const summary: string[] = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.farming > 0) summary.push(`一键务农${totalActions.farming}`);
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        const totalVisited: number = stealTargets.length + helpTargets.length;
        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend', event: '好友巡查循环', result: 'ok', visited: totalVisited, summary
            });
        }
        return summary.length > 0;

    } catch (err: any) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

// ============ 循环控制 ============

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop(): Promise<void> {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

interface StartOptions {
    externalScheduler?: boolean;
}

export function startFriendCheckLoop(options: StartOptions = {}): void {
    if (friendLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;

    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);

    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);

    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
    }

    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => checkAndAcceptApplications());
}

export function stopFriendCheckLoop(): void {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    clearPatrolVisited();
    clearAllInvalidKnownFriendGidCooldowns();
    clearFriendsListCache();
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

export function refreshFriendCheckLoop(delayMs: number = 200): void {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

/**
 * 处理服务器推送的好友申请
 */
export function onFriendApplicationReceived(applications: any[]): void {
    const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

    // 自动同意
    const gids: number[] = applications.map((a: any) => toNum(a.gid));
    acceptFriendsWithRetry(gids);
}

/**
 * 检查并同意所有待处理的好友申请
 */
async function checkAndAcceptApplications(): Promise<void> {
    try {
        const reply: any = await getApplications();
        const applications: any[] = reply.applications || [];
        if (applications.length === 0) return;

        const names: string = applications.map((a: any) => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);

        const gids: number[] = applications.map((a: any) => toNum(a.gid));
        await acceptFriendsWithRetry(gids);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    try {
        const reply: any = await acceptFriends(gids);
        const friends: any[] = reply.friends || [];
        if (friends.length > 0) {
            const names: string = friends.map((f: any) => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e: any) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 启动时执行一次放虫放草 ============

export async function runBadOnceOnStartup(): Promise<void> {
    if (badExecutedOnStartup) {
       // log('好友', '启动时放虫放草已执行过，跳过', { module: 'friend', event: '启动放虫放草跳过' });
        return;
    }

    const autoBadEnabled: boolean = isAutomationOn('friend_bad');
    if (!autoBadEnabled) {
      //  log('好友', '放虫放草功能未开启，跳过', { module: 'friend', event: '放虫放草未开启' });
        return;
    }

    const state: any = getUserState();
    if (!state.gid) {
        log('好友', '用户未登录，无法执行放虫放草', { module: 'friend', event: '放虫放草未登录' });
        return;
    }

    const accountId: string = process.env.FARM_ACCOUNT_ID || '';
    if (isBadOperationLimitReached()) return;

    log('好友', '========== 启动时放虫放草开始 ==========', { module: 'friend', event: '启动放虫放草开始' });

    try {
        const friendsReply: any = await getAllFriends();
        const friends: any[] = extractReplyFriends(friendsReply);
        if (friends.length === 0) {
            log('好友', '没有好友，放虫放草结束', { module: 'friend', event: '没有游戏好友' });
            return;
        }

        const blacklist: Set<number> = new Set(getFriendBlacklist(accountId));
        const badFriends: any[] = [];
        const visitedGids: Set<number> = new Set();

        // 筛选可捣乱的好友（排除成熟植物的好友）
        for (const f of friends) {
            const gid: number = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            if (blacklist.has(gid)) continue;

            const name: string = f.remark || f.name || `GID:${gid}`;
            const p: any = f.plant;
            const stealNum: number = p ? toNum(p.steal_plant_num) : 0;
            const dryNum: number = p ? toNum(p.dry_num) : 0;
            const weedNum: number = p ? toNum(p.weed_num) : 0;
            const insectNum: number = p ? toNum(p.insect_num) : 0;

            // 只没有可偷、可帮助的好友才考虑捣乱
            if (stealNum === 0 && dryNum === 0 && weedNum === 0 && insectNum === 0) {
                const level: number = toNum(f.level);
                badFriends.push({ gid, name, level });
            }

            visitedGids.add(gid);
        }

        // 按等级降序排序，优先处理等级高的好友
        badFriends.sort((a: any, b: any) => b.level - a.level);

        // 只取等级最高的前20个
        const topBadFriends: any[] = badFriends.slice(0, 20);
        log('好友', `找到 ${badFriends.length} 个可捣乱的好友，处理等级最高的前${topBadFriends.length}个`, { module: 'friend', event: '放虫放草好友列表', totalCount: badFriends.length, topCount: topBadFriends.length });

        const totalActions: any = { steal: 0, farming: 0, putBug: 0, putWeed: 0 };
        let processedCount: number = 0;

        for (let i: number = 0; i < topBadFriends.length; i++) {
            const friend: any = topBadFriends[i];
            if (isBadOperationLimitReached()) break;

            // 检查是否还有捣乱次数
            const canPutBug: boolean = canOperate(10004);
            const canPutWeed: boolean = canOperate(10003);
            if (!canPutBug && !canPutWeed) {
                log('好友', `放虫放草次数已用完，停止执行。已处理 ${processedCount} 个好友`, { module: 'friend', event: '放虫放草次数用完', processedCount });
                break;
            }

            log('好友', `启动时放虫放草 ${i + 1}/${topBadFriends.length}: ${friend.name} (等级${friend.level})`, { module: 'friend', event: '放虫放草处理好友', index: i + 1, total: topBadFriends.length, friendName: friend.name, level: friend.level });

            try {
                // 使用 visitFriend 函数，类似 V1 版本逻辑
                await visitFriend(friend, totalActions, state.gid);
                processedCount++;
            } catch (e: any) {
                log('好友', `放虫放草失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '放虫放草失败', friendName: friend.name, error: e.message });
            }

            if (isBadOperationLimitReached()) break;
            await randomDelay(2000, 3500);
        }

        badExecutedOnStartup = true;

        const summary: string[] = [];
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        log('好友', `========== 启动时放虫放草结束 ========== 处理${processedCount}人${summary.length > 0 ? ` → ${  summary.join('/')}` : ''}`, { module: 'friend', event: '启动放虫放草结束', processedCount, summary });

    } catch (err: any) {
        logWarn('好友', `启动时放虫放草异常: ${err.message}`);
    }
}

// ============ 公开状态查询 ============

// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
export function isHelpExpLimitReached(): boolean {
    return helpAutoDisabledByLimit;
}

