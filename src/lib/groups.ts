/**
 * 分组跟设备、跟流量的关系放在 shared/groups.ts，管理服务和 Agent 用的是同一份。
 * 这里只是转出去，让前端继续用 '../lib/groups' 这个路径。
 */
export { appliesTo, groupDeviceIds, isCatchAll } from '../../shared/groups.ts'
