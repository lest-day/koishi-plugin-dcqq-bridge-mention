# koishi-plugin-dcqq-bridge-mention

给 [`koishi-plugin-dcqq-bridge`](https://github.com/yilifaer/koishi-plugin-dcqq-bridge) 补上**真正的跨平台 @**。

不需要改 `dcqq-bridge` 一行代码，也不需要事先配置任何映射表。

```
Discord 里发：  hi @[qq:123456789]          →  QQ 群里真的 @ 到这个人
QQ 群里发：     hi @[dc:123456789012345678]  →  Discord 里真的 @ 到这个人
```

## 为什么需要这个插件

`dcqq-bridge` 自己的设计是「防 ping」的，两个方向都会阻止提及：

| 方向 | 原插件的行为 | 结果 |
|---|---|---|
| QQ → Discord | 每个请求都带 `allowed_mentions: { parse: [] }`；`escapeDiscord()` 还把 `<@` 拆成 `<\u200B@` | QQ 用户手打 `<@ID>` 在 Discord 里只是**文字**，ping 不到人 |
| Discord → QQ | `renderContent()` 把 `<@ID>` 渲染成 `@名字`；`buildQQSends()` 只产生 `text` 元素 | 到 QQ 端只是**文字**，没有 `[CQ:at]` |

本插件在**运行时**给这两个环节打补丁绕过它们。

## 工作原理

### QQ → Discord：沿 HTTP 原型链补丁

`dcqq-bridge` 不用适配器的 `sendMessage`，而是自己调 Discord API（`DiscordSender.send()` → `bot.http()`）。
`buildBody()` 里写死了 `allowed_mentions: { parse: [] }`，所以只能在这一层改。

`bot.http` 是 `ctx.http.extend()` 出来的实例（`extend()` 会新建原型），适配器内部的 REST 调用也走同一个
`bot.http`。本插件沿着 cordis HTTP 服务的原型链，找到真正拥有 `invoke`（`Symbol(cordis.invoke)`）的那层原型包起来，
这样一次就能拦到**所有** http 实例——不依赖拿不拿得到某个 bot 对象，换 bridge 版本也不容易漏。

在真正发出 `POST /channels/:id/messages`（或 `/webhooks/:id/:token`）**之前**：

1. 把正文里的 `@[dc:...]` 换成 `<@ID>`。
   注意这一步发生在 `escapeDiscord()` **之后**，所以那个用来防 ping 的零宽空格不会破坏提及；
   兼容 `@\[dc:...\]`（已转义）和 `@[dc:...]`（未转义）两种写法。
2. 把 `allowed_mentions` 改成只放行这些 ID：

```json
{ "parse": [], "users": ["123456789012345678"] }
```

> ⚠️ 这里必须写 `parse: []`，**不能**写 `parse: ["users"]`：
> Discord 的文档明确规定 `parse` 与 `users` 互斥，两者同时给非空值会直接 **400**。
> 只写 `users` 白名单才能既 ping 到指定用户，又继续保持 @everyone / 角色 ping 不到。

### Discord → QQ：补丁 `bot.sendMessage`

`dcqq-bridge` 最终通过 `sendQQ()` → `bot.sendMessage(groupId, elements)` 发给 QQ。
本插件把 OneBot 机器人的 `bot.sendMessage` 包一层，把 `text` 元素里的 `@[qq:...]`
换成真正的 `h.at(id)` 元素，OneBot 适配器会把它编码成 `[CQ:at,qq=ID]`。

## 名字也能用

数字 ID 直接生效；写成名字时按下面的顺序实时解析。
**查不到就显示成 `@未知用户`**（两个方向都是），并写一条警告日志——不会把原始语法暴露出来。

| 语法 | 解析方式 |
|---|---|
| `@[qq:123456789]` | 直接用这个 QQ 号 |
| `@[qq:群名片]` | 取该 QQ 群的成员列表，按**群名片 → 群昵称**匹配（精确 → 前缀 → 包含） |
| `@[dc:123456789012345678]` | 直接用这个 Discord 用户 ID |
| `@[dc:用户名]` | 先打 `GET /guilds/{guild}/members/search`，失败则取成员列表，按**用户名 / 全局名 / 服务器昵称**匹配 |
| 查不到 | `@未知用户` |

也就是说 Discord 那边可以直接用**群里看到的名字**（群名片优先，其次是 QQ 昵称）。
成员表和解析结果都缓存 5 分钟，不会每条消息都去查。

例：

```
Discord： @[qq:示例群名片] 在吗   → QQ 群里 @ 到「示例群名片」这个人
Discord： @[qq:查无此人] 在吗     → QQ 群里显示「@未知用户 在吗」
QQ 群：   @[dc:example_user] 在吗  → Discord 里 @ 到这个人
QQ 群：   @[dc:查无此人] 在吗     → Discord 里显示「@未知用户 在吗」
```

## 配置

装好启用即可，默认全部打开，**不需要填任何映射**。控制台里按下面四组折叠显示。

| 组 | 项 | 默认 | 说明 |
|---|---|---|---|
| — | `enabled` | 开 | 是否启用 |
| **转发方向** | `direction.d2q` | 开 | Discord → QQ（`@[qq:...]` 生成真 @） |
| | `direction.q2d` | 开 | QQ → Discord（`@[dc:...]` 生成真 @） |
| **黑名单** | `blacklist.forbidMention` | 空 | 禁止 @ 对方 |
| | `blacklist.forbidBeingMentioned` | 空 | 禁止被 @ |
| **发送效率** | `efficiency.lookupTimeoutMs` | 3000 | 按名字解析最长等待（毫秒） |
| | `efficiency.prewarm` | 开 | 后台预取 QQ 群成员表 |
| **高级** | `advanced.debug` | 关 | 调试日志 |

> 配置结构按分组调整过（旧版的 `d2q`、`forbidMention` 等平铺键移进了对应分组）。
> 升级后原来的黑名单内容需要在新分组里重新填一次。

### 发送效率（不堆积）

名字解析要查 API，如果不加控制，消息一多就会堆起来。这里做了四件事：

| 机制 | 作用 |
|---|---|
| **并发合并**（single-flight） | 多条消息同时要同一个群/同一个名字时，只发**一次**请求，其余共享结果 |
| **重请求限流** | 拉整个成员表最多同时 2 个，避免一次涌入把 OneBot 连接打满 |
| **超时降级** | 按名字解析最多等 `lookupTimeoutMs`（默认 3 秒），超时就发 `@未知用户`，不拖住消息；查询仍在后台跑，结果会进缓存，下次命中 |
| **后台预取** | 每条发往某群的消息都顺手看一眼该群成员表是否过期，过期就在后台刷新（不 await）。等真有人写「@[qq:群名片]」时基本都命中缓存 |

另外：

- **数字 ID 永远不查 API、不等待**——只有写名字才会触发查询。
- 查不到的负结果只缓存 60 秒（避免反复查），正面结果缓存 5 分钟。
- 成员表过期后会**先用旧值**解析、同时后台换新（stale-while-revalidate），所以不会因为缓存过期而突然卡一下。
- 同一个群的 8 条并发消息，实测只拉 1 次成员表。

不想让插件做任何后台请求，可以把 `prewarm` 关掉。

### 两个黑名单

两个名单的**行为完全一样**：命中时只删掉那个 `@[...]`，**消息其余内容照常发出**（不吞消息、不拦截）。
分成两个只是为了方便你把「不让人 @ 对侧」和「不让人被 @」两类维护开；任意一个命中都会生效。

- 每行一个，大小写不敏感，**两边写 @ 都检查**。
- 可以填：QQ 号、Discord 用户 ID、QQ 群名片、QQ 群昵称、Discord 用户名 / 全局名 / 服务器昵称。
- 可以加前缀限定只挡一侧：`qq:123456789` 只挡 QQ 提及，`dc:123456789012345678` 只挡 Discord 提及；不加前缀两侧通用。
- 写数字 ID 时只比对 ID，不查成员表（省一次 API）；写名字时会先查成员表再比对。
- 命中后**不会**把这个 ID 加进 `allowed_mentions`，所以不会 ping 到人。

```
blacklist:
  forbidMention:            # 禁止 @ 对方
    - qq:123456789          # 谁都不许 @ 这个 QQ 号
    - 示例群名片              # 按群名片挡
    - dc:123456789012345678 # 谁都不许 @ 这个 Discord 用户
  forbidBeingMentioned:     # 禁止被 @
    - 管理员本人              # 按名字挡
    - dc:example_user
```

例子：

```
QQ 群：  @[dc:example_user] 你好     → Discord 收到「 你好」（@ 被删，消息照发）
Discord：@[qq:123456789] 大家好    → QQ 群收到「 大家好」（@ 被删，消息照发）
```

> 如果整条消息**只有**一个被拉黑的 @，删完就没有内容了。这时会补一个不可见的零宽空格占位，
> 避免 Discord / OneBot 拒收空消息——消息仍然发得出去，只是看不到任何内容。

## 使用

1. 启用本插件（和 `dcqq-bridge` 的加载顺序**无所谓**，两个补丁都挂在最终发送环节上）。
2. 直接发消息：

```
Discord：  集合了 @[qq:123456789]
QQ 群：    集合了 @[dc:123456789012345678]
```

只有你显式写出的这些提及会 ping 到人，其它内容仍然保持 `dcqq-bridge` 原本的防 ping 行为。

## 已知限制

- **开了翻译时名字可能解析不到**：`dcqq-bridge` 的机翻会把没被识别为「提及」的文本发给模型，`@[dc:...]` 可能被改写。数字 ID 不受影响。
- **超长消息分段**：`@[qq:...]` 正好被切在 1500 字的边界上时可能失效（概率极低）。
- **Discord 按名字查找需要权限**：没有 `GUILD_MEMBERS` intent / 权限时成员搜索会失败，此时自动退回成员列表，再失败就发纯文字。
- **本插件会 ping 人**：这是它的目的，但与 `dcqq-bridge` 的「防 ping」默认行为相反。不想 ping 的桥就别写这个语法。
- 依赖 `dcqq-bridge` 的内部行为（走 `bot.http` 发 Discord、走 `bot.sendMessage` 发 QQ）。原插件改用别的发送路径时补丁会失效——失效时只是退回文字，不会报错。

## 开发

```bash
npm run typecheck
npm run build
npm test
```

`lib/` 由 `src/` 编译得到（CommonJS）。`npm test` 是不连 Discord / QQ 的自测：
QQ → Discord 这一路会起真实的 cordis http 服务、包真实原型链，只是把网络层换成替身，尽量贴近生产路径。
覆盖「数字 ID / 群名片 / 群昵称 / Discord 用户名 / 找不到 / 无语法 / 两个黑名单 / 整条只有一个被拉黑的 @ / 插件重载不叠加」。

## License

MIT
