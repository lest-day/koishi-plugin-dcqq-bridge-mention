import { Context } from 'koishi';
import { Config } from './config';
export declare const name = "dcqq-bridge-mention";
export { Config };
export declare const inject: {
    required: string[];
};
export declare function apply(ctx: Context, config: Config): void;
