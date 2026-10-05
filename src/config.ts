import { Schema } from 'koishi'

export interface Config {
  enabled: boolean
  direction: {
    d2q: boolean
    q2d: boolean
  }
  blacklist: {
    /** 禁止 @ 对方：命中即删掉这个 @（不吞消息）。 */
    forbidMention: string[]
    /** 禁止被 @：命中即删掉这个 @（不吞消息）。 */
    forbidBeingMentioned: string[]
  }
  efficiency: {
    /** 按名字解析最长等待（毫秒）；超时显示 @未知用户，后台继续查。 */
    lookupTimeoutMs: number
    /** 后台预取 QQ 群成员表。 */
    prewarm: boolean
  }
  advanced: {
    debug: boolean
  }
}

const BLACKLIST = '每行一个，支持 QQ 号 / Discord ID / 群名片 / 昵称 / 用户名，可带 `qq:`、`dc:` 前缀限定一侧'

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用'),

  direction: Schema.object({
    d2q: Schema.boolean().default(true).description('Discord → QQ（`@[qq:...]` 生成真 @）'),
    q2d: Schema.boolean().default(true).description('QQ → Discord（`@[dc:...]` 生成真 @）'),
  }).description('转发方向'),

  blacklist: Schema.object({
    forbidMention: Schema.array(Schema.string()).default([]).description('禁止 @ 对方\n' + BLACKLIST),
    forbidBeingMentioned: Schema.array(Schema.string()).default([]).description('禁止被 @\n' + BLACKLIST),
  }).description('黑名单（命中即删除 @，不吞消息）'),

  efficiency: Schema.object({
    lookupTimeoutMs: Schema.number().default(3000).description('按名字解析最长等待（毫秒），超时显示 @未知用户'),
    prewarm: Schema.boolean().default(true).description('后台预取 QQ 群成员表，名字 @ 几乎不用等'),
  }).description('发送效率'),

  advanced: Schema.object({
    debug: Schema.boolean().default(false).description('调试日志'),
  }).description('高级（一般不用动）'),
})
