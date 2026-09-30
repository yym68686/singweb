/**
 * sing-box 片段生成放在 shared/singbox.ts，管理服务和 Agent 复用同一份实现。
 * 这里只是转出去，让前端继续用 '../lib/singbox' 这个路径。
 */
export {
  blockRuleSetContent,
  blockRuleSetPath,
  blockRuleSetTag,
  buildSnippet,
  externalRuleSets,
  matchConditions,
  MIN_SINGBOX,
  PROBE_INBOUND,
  SECRET_PLACEHOLDER,
  toJson,
  versionAtLeast,
} from '../../shared/singbox.ts'
