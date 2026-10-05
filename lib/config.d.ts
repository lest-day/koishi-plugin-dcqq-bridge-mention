import { Schema } from 'koishi';
export interface Config {
    enabled: boolean;
    direction: {
        d2q: boolean;
        q2d: boolean;
    };
    blacklist: {
        /** 禁止 @ 对方：命中即删掉这个 @（不吞消息）。 */
        forbidMention: string[];
        /** 禁止被 @：命中即删掉这个 @（不吞消息）。 */
        forbidBeingMentioned: string[];
    };
    efficiency: {
        /** 按名字解析最长等待（毫秒）；超时显示 @未知用户，后台继续查。 */
        lookupTimeoutMs: number;
        /** 后台预取 QQ 群成员表。 */
        prewarm: boolean;
    };
    advanced: {
        debug: boolean;
    };
}
export declare const Config: Schema<Config>;
