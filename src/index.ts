import { Context } from 'koishi'
import { Config } from './config'
import { BridgeMention } from './mention'

export const name = 'dcqq-bridge-mention'
export { Config }

export const inject = { required: [] as string[] }

export function apply(ctx: Context, config: Config) {
  const mention = new BridgeMention(ctx, config)
  mention.start()
  ctx.on('dispose', () => mention.dispose())
}
