/** 提示用户手动复制时用的快捷键 */
export const COPY_KEYS = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘C' : 'Ctrl+C'

/**
 * 写入剪贴板。用 http 加内网 IP 打开管理服务时浏览器不提供 Clipboard API，
 * 这时改为选中文字再执行复制命令；还是不行就保留选中，让用户自己按快捷键。
 */
export async function copyText(text: string, source: HTMLElement): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 例如用户拒绝了剪贴板权限，下面换一种方式
    }
  }
  const selection = getSelection()
  selection?.selectAllChildren(source)
  if (document.execCommand('copy')) {
    selection?.removeAllRanges()
    return true
  }
  return false
}
