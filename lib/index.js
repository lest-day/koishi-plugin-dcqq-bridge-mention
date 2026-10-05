"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.Config = exports.name = void 0;
exports.apply = apply;
const config_1 = require("./config");
Object.defineProperty(exports, "Config", { enumerable: true, get: function () { return config_1.Config; } });
const mention_1 = require("./mention");
exports.name = 'dcqq-bridge-mention';
exports.inject = { required: [] };
function apply(ctx, config) {
    const mention = new mention_1.BridgeMention(ctx, config);
    mention.start();
    ctx.on('dispose', () => mention.dispose());
}
