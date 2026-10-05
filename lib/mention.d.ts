import { Context } from 'koishi';
import type { Config } from './config';
export declare class BridgeMention {
    private ctx;
    private config;
    private logger;
    /** groupId -> { at, list } */
    private qqMembers;
    /** channelId -> { at, id } */
    private dcGuilds;
    /** guildId -> { at, list } */
    private dcMembers;
    /** `${guildId}|${name}` -> { at, id } */
    private dcUsers;
    /** `webhookId:token` -> { at, id } */
    private dcWebhookChannels;
    /** 并发合并：同一个群/服务器/名字的请求只发一次 */
    private flight;
    /** 重请求（拉整个成员表）最多同时 2 个 */
    private heavy;
    private disposed;
    private warnedHttp;
    /** 禁止 @ 对方 */
    private forbidden;
    /** 禁止被 @ */
    private protectedTargets;
    constructor(ctx: Context, config: Config);
    /** 两个黑名单任一命中即视为「这个 @ 不该发出去」。 */
    private isForbidden;
    private debug;
    start(): void;
    dispose(): void;
    private patchAll;
    /** 沿原型链找到真正拥有 invoke 的原型并包一层；重载插件时由最新实例接管。 */
    private installHttpPatch;
    /** 每个出站请求都会经过这里；只处理发往 Discord 的消息创建。 */
    onHttpCall(http: any, args: any[]): Promise<void>;
    /** 在真正发出请求前，把正文里的 @[dc:...] 换成 <@ID> 并放行这些 ID。 */
    private rewriteDiscordBody;
    /** 就地替换 content，返回被放行的 Discord 用户 ID。 */
    private applyQ2D;
    /** 消息发往哪个频道：机器人模式在 URL 里，webhook 模式要问一下 webhook。 */
    private channelOf;
    private lookupWebhookChannel;
    private lookupTimeout;
    private resolveDiscord;
    /** 同一个名字的并发查询合并成一次；查完把结果写进缓存（超时也不会白查）。 */
    private searchDiscordUser;
    private guildOf;
    private lookupGuild;
    /** 成员表很重，所以：并发合并 + 限流 + 过期后先用旧值再后台刷新。 */
    private dcMemberList;
    private refreshDcMembers;
    private patchQQBot;
    /** 把 text 元素里的 `@[qq:...]` 换成 at 元素。 */
    private rewriteQQOutgoing;
    private resolveQQ;
    private qqMemberList;
    /**
     * 后台预取：某条消息要发往这个群时顺手把成员表刷一遍，
     * 这样等真有人写「@[qq:群名片]」时基本都命中缓存，不用在发送路径上等。
     * 自带 5 分钟缓存，所以最多每群每 5 分钟一次。
     */
    private prewarmQQ;
    /** 拉 QQ 群成员表：并发合并 + 限流，出错不抛（返回空表）。 */
    private refreshQQMembers;
}
