'use strict'
// 本地自测：不连 Discord/QQ。
// QQ → Discord 走「真实 cordis http 服务 + 原型链补丁」，最贴近生产路径。

const path = require('path')
const { Context, Service, h } = require('koishi')

const plugin = require(path.join(__dirname, '..', 'lib', 'index.js'))

function findInvokeTarget(start) {
  const direct = Service.invoke
  let current = start
  for (let depth = 0; current && depth < 12; depth++) {
    if (direct && Object.prototype.hasOwnProperty.call(current, direct) && typeof current[direct] === 'function') {
      return { proto: current, invoke: direct }
    }
    const symbol = Object.getOwnPropertySymbols(current).find((s) => typeof current[s] === 'function' && /invoke/i.test(String(s)))
    if (symbol) return { proto: current, invoke: symbol }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

function parseHttpArgs(args) {
  const first = args[0]
  if (typeof first === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(first)) {
    return { method: first.toUpperCase(), url: String(args[1] ?? ''), config: args[2] }
  }
  const config = args[1]
  return { method: String(config?.method ?? 'GET').toUpperCase(), url: String(first ?? ''), config }
}

const calls = { qq: [], http: [] }

function httpStub(...args) {
  const call = parseHttpArgs(args)
  calls.http.push({ method: call.method, url: call.url, config: call.config })
  const url = call.url
  if (call.method === 'GET' && /^\/webhooks\/\d+\/[^/?]+$/.test(url)) return { data: { id: '123', channel_id: '999' } }
  if (call.method === 'GET' && /^\/channels\/\d+$/.test(url)) return { data: { id: '999', guild_id: '345678901234567890' } }
  if (call.method === 'GET' && /\/members\/search/.test(url)) {
    if (/不存在/.test(decodeURIComponent(url))) return { data: [] }
    return { data: [{ user: { id: '123456789012345678', username: 'example_user', global_name: 'Example User' }, nick: '示例用户甲' }] }
  }
  if (call.method === 'GET' && /\/members\?/.test(url)) {
    return {
      data: [
        { user: { id: '123456789012345678', username: 'example_user', global_name: 'Example User' }, nick: '示例用户甲' },
        { user: { id: '234567890123456789', username: 'example_b', global_name: 'Example B' }, nick: '示例用户乙' },
      ],
    }
  }
  return { data: { id: 'dc-msg-1' } }
}

function types(elements) {
  return elements
    .map((el) => (el.type === 'text' ? `text(${JSON.stringify(el.attrs.content)})` : `${el.type}(${el.attrs.id ?? el.attrs.qq ?? JSON.stringify(el.attrs)})`))
    .join(' | ')
}

;(async () => {
  const app = new Context()
  const httpPlugin = require('@cordisjs/plugin-http')
  app.plugin(httpPlugin.default ?? httpPlugin)
  await new Promise((resolve) => setTimeout(resolve, 200))

  const target = findInvokeTarget(app.http)
  if (!target) throw new Error('找不到 http invoke 原型')
  target.proto[target.invoke] = httpStub

  const qqBot = {
    platform: 'onebot',
    selfId: '345678901',
    sendMessage: async (channelId, content) => {
      calls.qq.push({ channelId, content })
      return ['msg-1']
    },
    // 真实的 onebot 适配器形状：user.name = 昵称，nick = 群名片
    async getGuildMemberList(groupId) {
      stats.qqMemberFetches++
      if (String(groupId) === 'hang') {
        // 模拟「接口一直不返回」，验证发送路径不会被拖住
        await new Promise(() => {})
      }
      await new Promise((r) => setTimeout(r, 30))
      return { data: [{ user: { id: '234567890', name: '示例昵称' }, nick: '示例群名片' }] }
    },
  }
  const stats = { qqMemberFetches: 0 }

  const ctx = {
    bots: [qqBot],
    http: app.http,
    logger: () => ({ info: (...a) => console.log(...a), debug: () => {}, warn: (...a) => console.log('WARN', ...a) }),
    on: () => {},
  }

  // 与配置 schema 的分组保持一致
  const BASE = {
    enabled: true,
    direction: { d2q: true, q2d: true },
    blacklist: { forbidMention: [], forbidBeingMentioned: [] },
    efficiency: { lookupTimeoutMs: 3000, prewarm: true },
    advanced: { debug: false },
  }
  const merge = (base, extra) => {
    const out = { ...base }
    for (const key of Object.keys(extra ?? {})) {
      const value = extra[key]
      out[key] = value && typeof value === 'object' && !Array.isArray(value) ? { ...base[key], ...value } : value
    }
    return out
  }
  const start = (extra) => plugin.apply(ctx, merge(BASE, extra))
  start({})
  const botHttp = app.http.extend({ headers: { Authorization: 'Bot x' } })

  console.log('=== 1. Discord → QQ 数字 ID ===')
  await qqBot.sendMessage('123456', [h.text('[桥 - 示例用户]\nhi @[qq:123456789] there')])
  console.log(types(calls.qq.at(-1).content))

  console.log('\n=== 2. Discord → QQ 群名片（适配器真实形状 user.name/nick）===')
  await qqBot.sendMessage('123456', [h.text('@[qq:示例群名片] 早上好')])
  console.log(types(calls.qq.at(-1).content))

  console.log('\n=== 3. Discord → QQ 群昵称 ===')
  await qqBot.sendMessage('123456', [h.text('@[qq:示例昵称] 在吗')])
  console.log(types(calls.qq.at(-1).content))

  console.log('\n=== 3b. Discord → QQ 找不到名字 → @未知用户 ===')
  await qqBot.sendMessage('123456', [h.text('@[qq:根本没有这个人] 在吗')])
  console.log(types(calls.qq.at(-1).content))

  console.log('\n=== 4. QQ → Discord 数字 ID（已转义）===')
  await botHttp('/channels/999/messages', {
    method: 'POST',
    data: { content: 'hi @\\[dc:123456789012345678\\] x', allowed_mentions: { parse: [] } },
  })
  console.log(JSON.stringify(calls.http.at(-1).config.data))

  console.log('\n=== 5. QQ → Discord 用户名（webhook 模式）===')
  await botHttp('/webhooks/123/abc?wait=true', {
    method: 'POST',
    data: { content: '@[dc:example_user] ping', allowed_mentions: { parse: [] } },
  })
  console.log(JSON.stringify(calls.http.at(-1).config.data))

  console.log('\n=== 6. 没有语法时原样通过（防 ping 不变）===')
  await botHttp('/channels/999/messages', { method: 'POST', data: { content: '普通消息 <@999>', allowed_mentions: { parse: [] } } })
  console.log(JSON.stringify(calls.http.at(-1).config.data))

  console.log('\n=== 6b. QQ → Discord 找不到名字 → @未知用户 ===')
  await botHttp('/channels/999/messages', {
    method: 'POST',
    data: { content: '@[dc:不存在的人] 你好', allowed_mentions: { parse: [] } },
  })
  console.log(JSON.stringify(calls.http.at(-1).config.data))

  // ---------------------------------------------------------------- 黑名单

  console.log('\n=== 7. 禁止@对方（按 QQ 号）：删 @ 但保留消息 ===')
  start({ blacklist: { forbidMention: ['123456789'] } })
  await qqBot.sendMessage('123456', [h.text('@[qq:123456789] 大家好')])
  console.log(types(calls.qq.at(-1).content))

  console.log('\n=== 8. 禁止@对方（按群名片）：删 @ 但保留消息 ===')
  start({ blacklist: { forbidMention: ['示例群名片'] } })
  await qqBot.sendMessage('123456', [h.text('请 @[qq:示例群名片] 看一下')])
  console.log(types(calls.qq.at(-1).content))

  console.log('\n=== 9. 禁止被@（QQ → DC，按 DC 用户名）：删 @ 但保留消息 ===')
  start({ blacklist: { forbidBeingMentioned: ['example_user'] } })
  await botHttp('/channels/999/messages', {
    method: 'POST',
    data: { content: '@[dc:example_user] 你好', allowed_mentions: { parse: [] } },
  })
  console.log(JSON.stringify(calls.http.at(-1).config.data))

  console.log('\n=== 10. 禁止被@（QQ → DC，按 DC 数字 ID）===')
  start({ blacklist: { forbidBeingMentioned: ['dc:123456789012345678'] } })
  await botHttp('/channels/999/messages', {
    method: 'POST',
    data: { content: 'hi @\\[dc:123456789012345678\\] there', allowed_mentions: { parse: [] } },
  })
  console.log(JSON.stringify(calls.http.at(-1).config.data))

  console.log('\n=== 11. 整个消息只有一个被拉黑的 @（不吞消息、不空消息）===')
  start({ blacklist: { forbidMention: ['123456789'] } })
  await qqBot.sendMessage('123456', [h.text('@[qq:123456789]')])
  console.log('QQ 端：', types(calls.qq.at(-1).content))
  start({ blacklist: { forbidBeingMentioned: ['123456789012345678'] } })
  await botHttp('/channels/999/messages', {
    method: 'POST',
    data: { content: '@\\[dc:123456789012345678\\]', allowed_mentions: { parse: [] } },
  })
  console.log('DC 端：', JSON.stringify(calls.http.at(-1).config.data))

  console.log('\n=== 12. 黑名单不影响其他人 ===')
  start({ blacklist: { forbidMention: ['123456789'] } })
  await qqBot.sendMessage('123456', [h.text('@[qq:123456789] 和 @[qq:987654321] 一起')])
  console.log(types(calls.qq.at(-1).content))

  // ------------------------------------------------------------ 发送效率

  console.log('\n=== 13. 同一群的并发消息只拉一次成员表（并发合并）===')
  start({})
  const before13 = stats.qqMemberFetches
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => qqBot.sendMessage('888001', [h.text(`@[qq:示例群名片] 第${i}条`)]))
  )
  console.log('8 条并发消息 → 实际拉成员表次数：', stats.qqMemberFetches - before13, '(应为 1)')
  console.log('每条都解析成功：', calls.qq.slice(-8).every((c) => types(c.content).includes('at(234567890)')) ? 'OK' : 'FAIL')

  console.log('\n=== 14. 成员表接口卡住时不拖住发送（超时降级）===')
  start({ efficiency: { lookupTimeoutMs: 200 } })
  const t14 = Date.now()
  await qqBot.sendMessage('hang', [h.text('@[qq:某人] 在吗')])
  const cost = Date.now() - t14
  console.log('耗时 %d ms（应≈200ms，而不是一直等）', cost)
  console.log('结果：', types(calls.qq.at(-1).content))

  console.log('\n=== 15. 后台预取：没有名字提及的消息也会预热，之后名字 @ 不再等待 ===')
  start({})
  const before15 = stats.qqMemberFetches
  await qqBot.sendMessage('888002', [h.text('普通消息，没有 @')])
  await new Promise((r) => setTimeout(r, 80)) // 让后台预取跑完
  const afterPrewarm = stats.qqMemberFetches
  console.log('普通消息引发的后台预取：', afterPrewarm - before15, '次')
  const t15 = Date.now()
  await qqBot.sendMessage('888002', [h.text('@[qq:示例群名片] 现在 @')])
  console.log('之后名字 @ 耗时：', Date.now() - t15, 'ms', '（应几乎为 0，命中缓存）')
  console.log('结果：', types(calls.qq.at(-1).content))
  console.log('没有额外再拉成员表：', stats.qqMemberFetches === afterPrewarm ? 'OK' : `FAIL(+${stats.qqMemberFetches - afterPrewarm})`)

  console.log('\n=== 16. 数字 ID 完全不触发成员表查询（关掉预取以隔离）===')
  start({ efficiency: { prewarm: false } })
  const before16 = stats.qqMemberFetches
  await qqBot.sendMessage('888003', [h.text('@[qq:123456789] 你好')])
  console.log('拉成员表次数：', stats.qqMemberFetches - before16, '(应为 0，数字 ID 不查表)')
  console.log('结果：', types(calls.qq.at(-1).content))

  console.log('\n=== 17. 关掉预取后，普通消息不再产生任何后台请求 ===')
  const before17 = stats.qqMemberFetches
  await qqBot.sendMessage('888004', [h.text('普通消息')])
  await new Promise((r) => setTimeout(r, 80))
  console.log('后台请求次数：', stats.qqMemberFetches - before17, '(应为 0)')
})().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
