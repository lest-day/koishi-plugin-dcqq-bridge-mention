"use strict";
// koishi-plugin-dcqq-bridge-mention
//
// 在「不修改 koishi-plugin-dcqq-bridge」的前提下，为它补上真正的跨平台 @：
//
//   Discord → QQ   @[qq:QQ号]  @[qq:群名片或昵称]
//   QQ → Discord   @[dc:Discord用户ID]  @[dc:用户名/全局名/服务器昵称]
//
// 为什么需要「绕过」：
//   1) dcqq-bridge 发往 Discord 时，每个请求都带 allowed_mentions: { parse: [] }，
//      并且 escapeDiscord() 会把 `<@` 拆成 `<\u200B@`，所以 QQ 侧手写的 <@ID> 永远只是文字。
//   2) dcqq-bridge 发往 QQ 时，buildQQSends() 只产生 text 元素，Discord 的提及在
//      renderContent() 里已经被渲染成 `@名字`，因此不可能出现真正的 at 元素。
//
// 两个补丁的落点：
//
//   【QQ → Discord】沿 cordis HTTP 服务实例的原型链，找到真正拥有 invoke 的那一层
//     原型并包起来（Symbol(cordis.invoke)）。dcqq-bridge 用 bot.http(url, {...}) 直接发
//     Discord 消息，而 bot.http 是 ctx.http.extend() 出来的实例、适配器内部也走 bot.http，
//     所以包在原型链上可以一次覆盖所有 http 实例，不依赖「有没有拿到那个 bot 对象」。
//     在真正发出 POST /channels/:id/messages（或 /webhooks/...）之前，把正文里的
//     `@[dc:...]`（可能是 escapeDiscord() 转义后的 `@\[dc:...\]`）换成 `<@ID>`，
//     并把 allowed_mentions 改成只放行这些 ID。替换发生在转义之后，零宽空格不再影响提及。
//
//   【Discord → QQ】包 QQ 机器人的 bot.sendMessage。
//     dcqq-bridge 最终通过 bot.sendMessage(groupId, elements) 发出，这里把 text 元素里的
//     `@[qq:...]` 换成真正的 h.at(id)，由 OneBot 适配器编码为 [CQ:at,qq=ID]。
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeMention = void 0;
const koishi_1 = require("koishi");
/** Discord → QQ：`@[qq:...]` */
const D2Q_RE = () => /@\[qq:([^\]\r\n]+)\]/g;
/** QQ → Discord：`@[dc:...]`，兼容 escapeDiscord() 转义后的 `@\[dc:...\]` */
const Q2D_RE = () => /@\\?\[dc:([^\\\]\r\n]+)\\?\]/g;
const CACHE_TTL = 5 * 60 * 1000;
/** 过了 CACHE_TTL 但还没到这个时间：先把旧值用起来，同时在后台刷新（stale-while-revalidate）。 */
const STALE_TTL = 60 * 60 * 1000;
/** 「查不到」的短缓存：避免同一个查不到的名字每条消息都去查一次。 */
const NEGATIVE_TTL = 60 * 1000;
/* -------------------------------------------------- 避免堆积的三个小工具 */
/**
 * 合并同一个 key 上的并发请求（single-flight）。
 * 多条消息同时要同一个群的成员表时，只会真正发一次请求，其余共享同一个 Promise。
 */
class SingleFlight {
    /** 条目卡太久（底层请求一直不返回）就作废，免得后续查询永远复用同一个 pending Promise。 */
    static TTL = 60 * 1000;
    inflight = new Map();
    run(key, task) {
        const existing = this.inflight.get(key);
        if (existing) {
            if (Date.now() - existing.at < SingleFlight.TTL)
                return existing.promise;
            this.inflight.delete(key);
        }
        const entry = { at: Date.now(), promise: undefined };
        entry.promise = task().then((value) => {
            if (this.inflight.get(key) === entry)
                this.inflight.delete(key);
            return value;
        }, (error) => {
            if (this.inflight.get(key) === entry)
                this.inflight.delete(key);
            throw error;
        });
        this.inflight.set(key, entry);
        return entry.promise;
    }
}
/** 限制同时进行的「重请求」（拉整个群/服务器成员表）数量，避免一次涌入把连接打满。 */
class Limiter {
    max;
    queue = [];
    active = 0;
    constructor(max) {
        this.max = max;
    }
    async run(task) {
        if (this.active >= this.max)
            await new Promise((resolve) => this.queue.push(resolve));
        this.active++;
        try {
            return await task();
        }
        finally {
            this.active--;
            const next = this.queue.shift();
            if (next)
                next();
        }
    }
}
/**
 * 超时后返回 undefined（超时）而不是 null（查不到）——调用方靠这个区分：
 * 超时不能写进「查不到」的负面缓存，否则真存在的人会被误标 60 秒。
 * 超时不会取消底层请求，它跑完后照样会把结果写进缓存。
 */
function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolve(undefined);
        }, ms);
        promise.then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(undefined);
        });
    });
}
/**
 * 原始方法存在 bot 自己身上（而不是插件实例上）：这样插件重载后新实例能找到
 * 真正的原始方法，重新包一层最新的包装，而不是在旧包装上再套一层。
 */
const ORIGINALS = Symbol.for('dcqq-bridge-mention.originals');
/**
 * 每个「拥有 invoke 的原型对象」上的补丁状态。
 *
 * 注意：cordis 的 http.extend() 会**新建一个原型**（新原型的 __proto__ 才指向旧原型），
 * 所以包 HTTP.prototype 是拦不到扩展实例的。必须沿着实例的原型链往上，
 * 找到那个 **自己拥有** invoke 的原型再包——这样所有从它派生出来的实例都会被拦到。
 */
const protoStates = new WeakMap();
function originals(bot) {
    if (!bot[ORIGINALS])
        bot[ORIGINALS] = {};
    return bot[ORIGINALS];
}
function resolveHttpClass() {
    if (koishi_1.HTTP?.prototype)
        return koishi_1.HTTP;
    try {
        const mod = require('@cordisjs/plugin-http');
        if (mod?.HTTP?.prototype)
            return mod.HTTP;
        if (mod?.default?.HTTP?.prototype)
            return mod.default.HTTP;
    }
    catch { }
    return undefined;
}
/** 从任意对象出发，沿原型链找到「自己拥有」invoke 的那个原型。 */
function findInvokeTarget(start) {
    const direct = koishi_1.Service?.invoke;
    let current = start;
    for (let depth = 0; current && depth < 12; depth++) {
        if (direct && Object.prototype.hasOwnProperty.call(current, direct) && typeof current[direct] === 'function') {
            return { proto: current, invoke: direct };
        }
        const symbol = Object.getOwnPropertySymbols(current).find((item) => typeof current[item] === 'function' && /invoke/i.test(String(item)));
        if (symbol)
            return { proto: current, invoke: symbol };
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}
function isFormData(value) {
    return typeof FormData !== 'undefined' && value instanceof FormData;
}
function norm(value) {
    return String(value ?? '').trim().toLowerCase();
}
/** 从一个 Discord 成员对象里取出 id 和所有可用名字（兼容网关原始数据与 Satori Universal 结构）。 */
function memberInfo(entry) {
    if (!entry || typeof entry !== 'object')
        return null;
    const user = entry.user ?? entry;
    const id = String(user.id ?? entry.user_id ?? entry.id ?? '');
    if (!id)
        return null;
    const names = [user.username, user.global_name, user.name, user.nick, entry.nick, entry.nickname, entry.card]
        .filter((x) => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim());
    return { id, names };
}
function pickMember(list, raw) {
    const key = norm(raw);
    if (!key)
        return null;
    const infos = (Array.isArray(list) ? list : []).map(memberInfo).filter((x) => !!x);
    const exact = infos.find((m) => m.names.some((n) => norm(n) === key));
    if (exact)
        return exact.id;
    const prefix = infos.find((m) => m.names.some((n) => norm(n).startsWith(key)));
    if (prefix)
        return prefix.id;
    const loose = infos.find((m) => m.names.some((n) => norm(n).includes(key)));
    return loose ? loose.id : null;
}
function parseBlacklist(entries) {
    const any = new Set();
    const qq = new Set();
    const dc = new Set();
    for (const entry of entries ?? []) {
        const text = String(entry ?? '').trim();
        if (!text)
            continue;
        const scoped = /^(qq|dc)\s*[:：]\s*(.+)$/i.exec(text);
        const platform = scoped ? scoped[1].toLowerCase() : null;
        const value = (scoped ? scoped[2] : text).trim().toLowerCase();
        if (!value)
            continue;
        if (platform === 'qq')
            qq.add(value);
        else if (platform === 'dc')
            dc.add(value);
        else
            any.add(value);
    }
    return { any, qq, dc };
}
function hitsBlacklist(list, platform, raw, id) {
    const rawKey = norm(raw);
    const idKey = id ? norm(id) : '';
    if (rawKey && list.any.has(rawKey))
        return true;
    if (idKey && list.any.has(idKey))
        return true;
    const scoped = platform === 'qq' ? list.qq : list.dc;
    if (rawKey && scoped.has(rawKey))
        return true;
    if (idKey && scoped.has(idKey))
        return true;
    return false;
}
/**
 * 只放行我们解析出来的这些用户，其余提及保持 dcqq-bridge 的「不 ping」行为。
 *
 * 注意 Discord 的规则：parse 与 users 互斥——`parse: ['users']` 和非空 `users`
 * 同时出现会被判为 400。所以这里必须写 `parse: []`，只靠 `users` 白名单放行指定用户；
 * @everyone / 角色仍然 ping 不到。
 */
function allowMentions(previous, ids) {
    const users = new Set(Array.isArray(previous?.users) ? previous.users.map(String) : []);
    for (const id of ids)
        users.add(String(id));
    return { parse: [], users: [...users] };
}
function parseHttpArgs(args) {
    const first = args[0];
    if (typeof first === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(first)) {
        return { method: first.toUpperCase(), url: String(args[1] ?? ''), config: args[2] };
    }
    const config = args[1];
    return {
        method: String(config?.method ?? 'GET').toUpperCase(),
        url: String(first ?? ''),
        config,
    };
}
function isMessageEndpoint(url) {
    return /\/messages(\?|$)/.test(url) || /\/webhooks\/\d+\//.test(url);
}
class BridgeMention {
    ctx;
    config;
    logger;
    /** groupId -> { at, list } */
    qqMembers = new Map();
    /** channelId -> { at, id } */
    dcGuilds = new Map();
    /** guildId -> { at, list } */
    dcMembers = new Map();
    /** `${guildId}|${name}` -> { at, id } */
    dcUsers = new Map();
    /** `webhookId:token` -> { at, id } */
    dcWebhookChannels = new Map();
    /** 并发合并：同一个群/服务器/名字的请求只发一次 */
    flight = new SingleFlight();
    /** 重请求（拉整个成员表）最多同时 2 个 */
    heavy = new Limiter(2);
    disposed = false;
    warnedHttp = false;
    /** 禁止 @ 对方 */
    forbidden;
    /** 禁止被 @ */
    protectedTargets;
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
        this.logger = ctx.logger('dcqq-bridge-mention');
        this.forbidden = parseBlacklist(config.blacklist?.forbidMention);
        this.protectedTargets = parseBlacklist(config.blacklist?.forbidBeingMentioned);
    }
    /** 两个黑名单任一命中即视为「这个 @ 不该发出去」。 */
    isForbidden(platform, raw, id) {
        return hitsBlacklist(this.forbidden, platform, raw, id) || hitsBlacklist(this.protectedTargets, platform, raw, id);
    }
    debug(format, ...args) {
        if (this.config.advanced?.debug)
            this.logger.info(format, ...args);
        else
            this.logger.debug(format, ...args);
    }
    /* ------------------------------------------------------------------ 启动 */
    start() {
        if (!this.config.enabled) {
            this.logger.info('dcqq-bridge-mention 已停用');
            return;
        }
        this.installHttpPatch();
        // bot 可能在插件之后才连上，随时补齐补丁
        this.ctx.on('ready', () => this.patchAll(), true);
        this.ctx.on('message-created', () => this.patchAll(), true);
        this.ctx.on('discord/message-create', () => this.patchAll(), true);
        this.ctx.on('dispose', () => this.dispose());
        this.patchAll();
        this.logger.info('dcqq-bridge-mention 已启用：@[qq:...] / @[dc:...] 会生成真正的平台 @');
    }
    dispose() {
        this.disposed = true;
    }
    patchAll() {
        if (this.disposed || !this.config.enabled)
            return;
        this.installHttpPatch();
        for (const bot of this.ctx.bots) {
            if (bot.platform === 'onebot')
                this.patchQQBot(bot);
        }
    }
    /* --------------------------------------------- QQ → Discord：HTTP 原型补丁 */
    /** 沿原型链找到真正拥有 invoke 的原型并包一层；重载插件时由最新实例接管。 */
    installHttpPatch() {
        const start = this.ctx?.http;
        const found = findInvokeTarget(start) ?? findInvokeTarget(resolveHttpClass());
        if (!found) {
            if (!this.warnedHttp) {
                this.warnedHttp = true;
                this.logger.warn('找不到 HTTP 的调用入口，QQ → Discord 的真实 @ 无法启用');
            }
            return false;
        }
        const { proto, invoke } = found;
        let state = protoStates.get(proto);
        if (!state) {
            state = { original: proto[invoke] };
            protoStates.set(proto, state);
            proto[invoke] = async function (...args) {
                const current = protoStates.get(proto);
                const owner = current?.owner;
                if (owner) {
                    try {
                        await owner.onHttpCall(this, args);
                    }
                    catch (error) {
                        owner.logger.warn('改写 Discord 消息的 @ 失败：%s', error?.message ?? error);
                    }
                }
                return protoStates.get(proto).original.apply(this, args);
            };
            this.debug('HTTP 补丁已安装（%s）', String(invoke));
        }
        state.owner = this;
        return true;
    }
    /** 每个出站请求都会经过这里；只处理发往 Discord 的消息创建。 */
    async onHttpCall(http, args) {
        const call = parseHttpArgs(args);
        if (call.method !== 'POST' || !isMessageEndpoint(call.url))
            return;
        await this.rewriteDiscordBody(http, call.url, call.config);
    }
    /** 在真正发出请求前，把正文里的 @[dc:...] 换成 <@ID> 并放行这些 ID。 */
    async rewriteDiscordBody(http, url, config) {
        if (!this.config.direction?.q2d || !config)
            return;
        const data = config.data;
        if (!data)
            return;
        // 先做最便宜的判断：绝大多数消息里根本没有 @[dc:...]，直接原样放行，不做任何多余工作
        if (typeof data.content === 'string') {
            if (!data.content.includes('[dc:'))
                return;
            const ids = await this.applyQ2D(http, url, data);
            if (!ids.length)
                return;
            data.allowed_mentions = allowMentions(data.allowed_mentions, ids);
            return;
        }
        if (isFormData(data)) {
            const payload = data.get('payload_json');
            if (typeof payload !== 'string' || !payload.includes('[dc:'))
                return;
            let json;
            try {
                json = JSON.parse(payload);
            }
            catch {
                return;
            }
            const ids = await this.applyQ2D(http, url, json);
            if (!ids.length)
                return;
            json.allowed_mentions = allowMentions(json.allowed_mentions, ids);
            data.set('payload_json', JSON.stringify(json));
            return;
        }
        if (typeof data !== 'string')
            return;
        if (!data.includes('[dc:'))
            return;
        let json;
        try {
            json = JSON.parse(data);
        }
        catch {
            return;
        }
        const ids = await this.applyQ2D(http, url, json);
        if (!ids.length)
            return;
        json.allowed_mentions = allowMentions(json.allowed_mentions, ids);
        config.data = JSON.stringify(json);
    }
    /** 就地替换 content，返回被放行的 Discord 用户 ID。 */
    async applyQ2D(http, url, payload) {
        if (typeof payload.content !== 'string')
            return [];
        const re = Q2D_RE();
        const matches = [...payload.content.matchAll(re)];
        if (!matches.length)
            return [];
        this.debug('QQ → Discord：%s 里有 %d 个 @[dc:...] 要处理', url, matches.length);
        // 只有真的要按用户名查时才去解析频道，纯数字 ID 不必多打一次 API
        let channelId;
        const needChannel = async () => {
            if (channelId === undefined)
                channelId = await this.channelOf(http, url);
            return channelId;
        };
        const resolved = new Map();
        const removed = new Set();
        const unknown = new Set();
        for (const match of matches) {
            const key = match[1];
            const raw = key.trim();
            if (!raw)
                continue;
            // 黑名单：先按用户写下的原文匹配（ID 或名字都能挡），命中就直接删，不查 API
            if (this.isForbidden('dc', raw, null)) {
                removed.add(key);
                continue;
            }
            if (/^\d+$/.test(raw)) {
                if (this.isForbidden('dc', raw, raw))
                    removed.add(key);
                else
                    resolved.set(key, raw);
                continue;
            }
            const channel = await needChannel();
            if (!channel) {
                this.logger.warn('QQ → Discord：认不出 %s 对应的频道，无法按用户名查找', url);
                unknown.add(key);
                continue;
            }
            const id = await this.resolveDiscord(http, channel, raw);
            if (id && this.isForbidden('dc', raw, id)) {
                removed.add(key);
                continue;
            }
            if (id)
                resolved.set(key, id);
            else {
                unknown.add(key);
                this.logger.warn('QQ → Discord：Discord 里找不到「%s」，显示为 @未知用户', raw);
            }
        }
        if (!resolved.size && !removed.size && !unknown.size)
            return [];
        const ids = [];
        payload.content = payload.content.replace(re, (full, raw) => {
            if (removed.has(raw)) {
                this.debug('QQ → Discord：@[dc:%s] 命中黑名单，删除这个 @', raw.trim());
                return '';
            }
            if (unknown.has(raw)) {
                this.debug('QQ → Discord：@[dc:%s] 查不到，显示为 @未知用户', raw.trim());
                return '@未知用户';
            }
            const id = resolved.get(raw);
            if (!id)
                return full;
            ids.push(id);
            this.debug('QQ → Discord：@[dc:%s] → <@%s>', raw.trim(), id);
            return `<@${id}>`;
        });
        // 整条消息只有一个被拉黑的 @ 时，删完就空了；Discord 不收空 content，用零宽空格占位
        if (!payload.content.trim())
            payload.content = '\u200b';
        return [...new Set(ids)];
    }
    /** 消息发往哪个频道：机器人模式在 URL 里，webhook 模式要问一下 webhook。 */
    async channelOf(http, url) {
        const direct = /\/channels\/(\d+)\/messages/.exec(url);
        if (direct)
            return direct[1];
        const hook = /\/webhooks\/(\d+)\/([^/?]+)/.exec(url);
        if (!hook)
            return null;
        const key = hook[1] + ':' + hook[2];
        const cached = this.dcWebhookChannels.get(key);
        if (cached) {
            const ttl = cached.id ? CACHE_TTL : NEGATIVE_TTL;
            if (Date.now() - cached.at < ttl)
                return cached.id;
        }
        const id = await withTimeout(this.lookupWebhookChannel(http, key, hook[1], hook[2]), this.lookupTimeout());
        return id === undefined ? (cached?.id ?? null) : id;
    }
    lookupWebhookChannel(http, key, id, token) {
        return this.flight.run('webhook:' + key, async () => {
            let channel = null;
            try {
                const response = await http('GET', `/webhooks/${id}/${token}`);
                channel = response?.data?.channel_id ?? null;
            }
            catch (error) {
                this.debug('读取 webhook %s 失败：%s', key, error?.message ?? error);
                channel = null;
            }
            this.dcWebhookChannels.set(key, { at: Date.now(), id: channel });
            return channel;
        });
    }
    /* ------------------------------------------------------------ 名字 → ID */
    lookupTimeout() {
        const value = Number(this.config.efficiency?.lookupTimeoutMs);
        return Number.isFinite(value) && value > 0 ? value : 3000;
    }
    async resolveDiscord(http, channelId, raw) {
        const guildId = await this.guildOf(http, channelId);
        if (!guildId)
            return null;
        const key = guildId + '|' + norm(raw);
        const cached = this.dcUsers.get(key);
        if (cached) {
            // 查不到只短缓存，免得新成员一直找不到
            const ttl = cached.id ? CACHE_TTL : NEGATIVE_TTL;
            if (Date.now() - cached.at < ttl)
                return cached.id;
        }
        const id = await withTimeout(this.searchDiscordUser(http, guildId, raw, key), this.lookupTimeout());
        // 超时：不算「查不到」，不写负面缓存，先用旧值
        if (id === undefined)
            return cached?.id ?? null;
        return id;
    }
    /** 同一个名字的并发查询合并成一次；查完把结果写进缓存（超时也不会白查）。 */
    searchDiscordUser(http, guildId, raw, key) {
        return this.flight.run('search:' + key, async () => {
            let id = null;
            try {
                const response = await http('GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(raw)}&limit=10`);
                id = pickMember(response?.data, raw);
            }
            catch (error) {
                this.debug('Discord 成员搜索失败（%s），改用成员列表', error?.message ?? error);
                id = null;
            }
            if (!id) {
                const list = await this.dcMemberList(http, guildId);
                id = pickMember(list, raw);
            }
            this.dcUsers.set(key, { at: Date.now(), id });
            this.debug('Discord 成员查找：%s → %s', raw, id ?? '查不到');
            return id;
        });
    }
    async guildOf(http, channelId) {
        const cached = this.dcGuilds.get(channelId);
        if (cached) {
            const ttl = cached.id ? CACHE_TTL : NEGATIVE_TTL;
            if (Date.now() - cached.at < ttl)
                return cached.id;
        }
        const id = await withTimeout(this.lookupGuild(http, channelId), this.lookupTimeout());
        return id === undefined ? (cached?.id ?? null) : id;
    }
    lookupGuild(http, channelId) {
        return this.flight.run('guild:' + channelId, async () => {
            let id = null;
            try {
                const response = await http('GET', `/channels/${channelId}`);
                id = response?.data?.guild_id ?? null;
            }
            catch (error) {
                this.debug('读取频道 %s 失败：%s', channelId, error?.message ?? error);
                id = null;
            }
            this.dcGuilds.set(channelId, { at: Date.now(), id });
            return id;
        });
    }
    /** 成员表很重，所以：并发合并 + 限流 + 过期后先用旧值再后台刷新。 */
    async dcMemberList(http, guildId) {
        const cached = this.dcMembers.get(guildId);
        if (cached) {
            const age = Date.now() - cached.at;
            if (age < (cached.list.length ? CACHE_TTL : NEGATIVE_TTL))
                return cached.list;
            if (cached.list.length && age < STALE_TTL) {
                // 先用旧值，后台补新的：本次解析完全不等待
                void this.refreshDcMembers(http, guildId);
                return cached.list;
            }
        }
        const list = await withTimeout(this.refreshDcMembers(http, guildId), this.lookupTimeout());
        return list ?? cached?.list ?? [];
    }
    refreshDcMembers(http, guildId) {
        return this.flight.run('dcmembers:' + guildId, () => this.heavy.run(async () => {
            let list = [];
            try {
                const response = await http('GET', `/guilds/${guildId}/members?limit=1000`);
                list = Array.isArray(response?.data) ? response.data : [];
            }
            catch (error) {
                this.debug('读取服务器 %s 成员列表失败：%s', guildId, error?.message ?? error);
                list = [];
            }
            this.dcMembers.set(guildId, { at: Date.now(), list });
            this.debug('Discord 服务器 %s 成员表：%d 人', guildId, list.length);
            return list;
        }));
    }
    /* ------------------------------------------------- Discord → QQ 真正的 at */
    patchQQBot(bot) {
        if (!bot || typeof bot.sendMessage !== 'function')
            return;
        const store = originals(bot);
        if (!store.sendMessage)
            store.sendMessage = bot.sendMessage;
        if (store.qqOwner === this && store.qqPatched === bot.sendMessage)
            return;
        const self = this;
        const original = store.sendMessage;
        const patched = async function (channelId, content, ...rest) {
            let elements = content;
            try {
                // 顺手在后台把该群成员表刷新一下（最多 5 分钟一次）：不 await，不影响这条消息
                self.prewarmQQ(bot, channelId);
                elements = await self.rewriteQQOutgoing(bot, channelId, content);
            }
            catch (error) {
                self.logger.warn('改写 QQ 消息的 @ 失败：%s', error?.message ?? error);
                elements = content;
            }
            return original.call(bot, channelId, elements, ...rest);
        };
        store.qqOwner = this;
        store.qqPatched = patched;
        bot.sendMessage = patched;
    }
    /** 把 text 元素里的 `@[qq:...]` 换成 at 元素。 */
    async rewriteQQOutgoing(bot, groupId, content) {
        if (!this.config.direction?.d2q)
            return content;
        let elements = content;
        if (typeof elements === 'string') {
            if (!elements.includes('@[qq:'))
                return content;
            elements = koishi_1.h.parse(elements);
        }
        if (!Array.isArray(elements))
            return content;
        const has = elements.some((el) => el && el.type === 'text' && typeof el.attrs?.content === 'string' && D2Q_RE().test(el.attrs.content));
        if (!has)
            return content;
        const out = [];
        for (const el of elements) {
            const text = el && el.type === 'text' ? el.attrs?.content : null;
            if (typeof text !== 'string' || !text.includes('@[qq:')) {
                out.push(el);
                continue;
            }
            const local = D2Q_RE();
            let last = 0;
            let match;
            while ((match = local.exec(text)) !== null) {
                const before = text.slice(last, match.index);
                if (before)
                    out.push(koishi_1.h.text(before));
                const raw = match[1].trim();
                // 黑名单：先按用户写下的原文匹配，命中就直接删，不查成员表
                if (this.isForbidden('qq', raw, null)) {
                    this.debug('Discord → QQ：@[qq:%s] 命中黑名单，删除这个 @', raw);
                    last = match.index + match[0].length;
                    continue;
                }
                const id = await this.resolveQQ(bot, groupId, raw);
                if (id && this.isForbidden('qq', raw, id)) {
                    this.debug('Discord → QQ：@[qq:%s]（%s）命中黑名单，删除这个 @', raw, id);
                }
                else if (id) {
                    out.push(koishi_1.h.at(id));
                    this.debug('Discord → QQ：@[qq:%s] → at(%s)', raw, id);
                }
                else {
                    out.push(koishi_1.h.text('@未知用户'));
                    this.logger.warn('Discord → QQ：QQ 群 %s 里找不到「%s」，显示为 @未知用户', groupId, raw);
                }
                last = match.index + match[0].length;
            }
            const after = text.slice(last);
            if (after)
                out.push(koishi_1.h.text(after));
        }
        // 整条消息只有一个被拉黑的 @ 时，删完就没有可见内容了；空消息 OneBot 会报错，用零宽空格占位
        const hasContent = out.some((el) => el.type !== 'text' || el.attrs?.content);
        if (!hasContent)
            out.push(koishi_1.h.text('\u200b'));
        return out;
    }
    async resolveQQ(bot, groupId, raw) {
        if (/^\d+$/.test(raw))
            return raw;
        const list = await this.qqMemberList(bot, groupId);
        return pickMember(list, raw);
    }
    async qqMemberList(bot, groupId) {
        const cached = this.qqMembers.get(groupId);
        if (cached) {
            const age = Date.now() - cached.at;
            if (age < (cached.list.length ? CACHE_TTL : NEGATIVE_TTL))
                return cached.list;
            if (cached.list.length && age < STALE_TTL) {
                // 过期但还能用：先用旧值解析（本次完全不等待），后台悄悄换新的
                void this.refreshQQMembers(bot, groupId);
                return cached.list;
            }
        }
        const list = await withTimeout(this.refreshQQMembers(bot, groupId), this.lookupTimeout());
        return list ?? cached?.list ?? [];
    }
    /**
     * 后台预取：某条消息要发往这个群时顺手把成员表刷一遍，
     * 这样等真有人写「@[qq:群名片]」时基本都命中缓存，不用在发送路径上等。
     * 自带 5 分钟缓存，所以最多每群每 5 分钟一次。
     */
    prewarmQQ(bot, groupId) {
        // 只有显式关掉才不预热：老配置里没这一项时是 undefined，应视为默认开
        if (this.config.efficiency?.prewarm === false)
            return;
        const cached = this.qqMembers.get(groupId);
        if (cached && Date.now() - cached.at < CACHE_TTL)
            return;
        void this.refreshQQMembers(bot, groupId);
    }
    /** 拉 QQ 群成员表：并发合并 + 限流，出错不抛（返回空表）。 */
    refreshQQMembers(bot, groupId) {
        return this.flight.run('qqmembers:' + groupId, () => this.heavy.run(async () => {
            let raw = [];
            try {
                if (typeof bot.getGuildMemberList === 'function') {
                    const result = await bot.getGuildMemberList(groupId);
                    raw = result?.data ?? result ?? [];
                }
            }
            catch (error) {
                this.debug('读取 QQ 群 %s 成员表失败：%s', groupId, error?.message ?? error);
                raw = [];
            }
            if (!Array.isArray(raw) || !raw.length) {
                try {
                    const request = bot.internal?._request;
                    if (typeof request === 'function') {
                        const result = await request.call(bot.internal, 'get_group_member_list', { group_id: groupId });
                        raw = result?.data ?? result ?? [];
                    }
                }
                catch (error) {
                    this.debug('get_group_member_list 失败：%s', error?.message ?? error);
                    raw = [];
                }
            }
            // 适配器 getGuildMemberList 返回的是 { user: { id, name: 昵称, username }, nick: 群名片 }
            // （见 onebot 适配器 decodeGuildMember：user 来自 user_id/nickname，nick 来自 card）。
            // 原始 get_group_member_list 则是 { user_id, nickname, card }。两种形状都要认，
            // 尤其是群名片：它只出现在 entry.nick / entry.card，漏了就等于「按群内名称 @」失效。
            const list = (Array.isArray(raw) ? raw : []).map((entry) => ({
                user: {
                    id: String(entry?.user_id ?? entry?.user?.id ?? entry?.id ?? ''),
                    name: String(entry?.nickname ?? entry?.user?.name ?? entry?.user?.username ?? entry?.name ?? ''),
                    nick: String(entry?.card ?? entry?.nick ?? entry?.user?.nick ?? ''),
                },
            }));
            const filtered = list.filter((m) => m.user.id && (m.user.name || m.user.nick));
            this.qqMembers.set(groupId, { at: Date.now(), list: filtered });
            this.debug('QQ 群 %s 成员表：%d 人', groupId, filtered.length);
            return filtered;
        }));
    }
}
exports.BridgeMention = BridgeMention;
