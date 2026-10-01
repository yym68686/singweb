/**
 * sing-box 相关的少量判断放在 shared/singbox.ts，管理服务、Agent 和前端共用一份。
 * 这里只转出前端真正用得到的那几个：整份配置由服务端生成（POST /config/preview），
 * 前端不再自己拼配置。
 */
export { MIN_SINGBOX, singboxTooOld, toJson } from '../../shared/singbox.ts'
