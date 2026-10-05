"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Config = void 0;
const koishi_1 = require("koishi");
const BLACKLIST = '每行一个，支持 QQ 号 / Discord ID / 群名片 / 昵称 / 用户名，可带 `qq:`、`dc:` 前缀限定一侧';
exports.Config = koishi_1.Schema.object({
    enabled: koishi_1.Schema.boolean().default(true).description('是否启用'),
    direction: koishi_1.Schema.object({
        d2q: koishi_1.Schema.boolean().default(true).description('Discord → QQ（`@[qq:...]` 生成真 @）'),
        q2d: koishi_1.Schema.boolean().default(true).description('QQ → Discord（`@[dc:...]` 生成真 @）'),
    }).description('转发方向'),
    blacklist: koishi_1.Schema.object({
        forbidMention: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description('禁止 @ 对方\n' + BLACKLIST),
        forbidBeingMentioned: koishi_1.Schema.array(koishi_1.Schema.string()).default([]).description('禁止被 @\n' + BLACKLIST),
    }).description('黑名单（命中即删除 @，不吞消息）'),
    efficiency: koishi_1.Schema.object({
        lookupTimeoutMs: koishi_1.Schema.number().default(3000).description('按名字解析最长等待（毫秒），超时显示 @未知用户'),
        prewarm: koishi_1.Schema.boolean().default(true).description('后台预取 QQ 群成员表，名字 @ 几乎不用等'),
    }).description('发送效率'),
    advanced: koishi_1.Schema.object({
        debug: koishi_1.Schema.boolean().default(false).description('调试日志'),
    }).description('高级（一般不用动）'),
});
