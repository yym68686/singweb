/**
 * 候选节点的挑选逻辑放在 shared/candidates.ts，管理服务和 Agent 用的是同一份。
 * 这里只是转出去，让前端继续用 '../lib/candidates' 这个路径。
 */
export { candidateIds, enabledCandidates, matchesFilter } from '../../shared/candidates.ts'
