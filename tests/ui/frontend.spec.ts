import { expect, test, type Locator, type Page } from '@playwright/test'

const routes = [
  '/',
  '/devices',
  '/devices/not-present',
  '/matrix',
  '/events',
  '/groups',
  '/groups/new',
  '/groups/not-present',
  '/targets',
  '/nodes',
  '/not-found',
]

async function expectDialogCentered(dialog: Locator) {
  // Wait for the short entrance translation before measuring the final position.
  await expect.poll(() => dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return Math.max(Math.abs(rect.x + rect.width / 2 - innerWidth / 2), Math.abs(rect.y + rect.height / 2 - innerHeight / 2))
  })).toBeLessThanOrEqual(1)
  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(16)
  expect(bounds.top).toBeGreaterThanOrEqual(23)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width - 16)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 23)
}

async function installApiMocks(page: Page, options: { populated?: boolean; failNodes?: boolean } = {}) {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', { value: undefined })
  })
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname.endsWith('/auth/me')) {
      await route.fulfill({ json: { user: { id: 'ui-test', username: 'tester', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' } } })
      return
    }
    if (pathname.endsWith('/events')) {
      await route.fulfill({ json: { items: [], nextCursor: null } })
      return
    }
    if (pathname.endsWith('/config/preview')) {
      await route.fulfill({ json: { config: {}, warnings: [] } })
      return
    }
    if (options.failNodes && pathname.endsWith('/nodes')) {
      await route.fulfill({ status: 503, json: { message: '模拟服务不可用' } })
      return
    }
    if (options.populated && pathname.endsWith('/devices')) {
      await route.fulfill({ json: { items: [device] } })
      return
    }
    if (options.populated && pathname.endsWith('/nodes')) {
      await route.fulfill({ json: { items: [node] } })
      return
    }
    if (options.populated && pathname.endsWith('/groups') && route.request().method() === 'GET') {
      await route.fulfill({ json: { items: [group] } })
      return
    }
    if (options.populated && pathname.endsWith('/targets')) {
      await route.fulfill({ json: { items: [target] } })
      return
    }
    if (options.populated && pathname.endsWith('/runtime')) {
      await route.fulfill({ json: { items: [runtime] } })
      return
    }
    if (pathname.endsWith('/subscription')) {
      await route.fulfill({ json: { token: 'fake-ui-regression-token' } })
      return
    }
    if (pathname.endsWith('/groups') && route.request().method() === 'POST') {
      await route.fulfill({ status: 422, json: { message: '测试字段校验', field: 'failThreshold' } })
      return
    }
    await route.fulfill({ json: { items: [] } })
  })
}

const device = {
  id: 'device-1', name: '测试设备', hostname: 'test-host', platform: 'linux', osVersion: 'Linux',
  agentVersion: '1.0.0', singboxVersion: '1.12.0', online: true, lastSeenAt: '2026-01-01T00:00:00.000Z',
  clashApi: '127.0.0.1:9090', probeInbound: '127.0.0.1:1080', dataDir: '/tmp', proxyListen: '', singboxError: null,
}
const node = {
  id: 'node-1', tag: '东京节点', protocol: 'vless', server: 'proxy.example.com', port: 443, region: '日本',
  enabled: true, source: 'UI test', sourceId: null,
}
const target = {
  id: 'target-1', kind: 'tcp', name: '测试服务', host: 'service.example.com', port: 443, timeoutMs: 3000,
}
const group = {
  id: 'group-1', name: '默认分组', selectorTag: 'default-out', deviceIds: [],
  match: { domains: [], domainKeywords: [], ipCidrs: [], ruleSets: [], protocols: [], ports: [], processNames: [] },
  candidates: { mode: 'list', nodeIds: ['node-1'] }, selection: 'auto', targetIds: ['target-1'], targetMode: 'all',
  strategy: 'priority', failThreshold: 3, recoverThreshold: 2, probeIntervalSec: 30, toleranceMs: 150,
  failback: true, interruptExisting: false, onAllFail: 'block', updatedAt: '2026-01-01T00:00:00.000Z',
}
const runtime = {
  deviceId: device.id, groupId: group.id, activeNodeId: node.id, pinnedNodeId: null, state: 'ok',
  eligibleNodeIds: [node.id], nodes: [{ nodeId: node.id, state: 'up', consecutiveFails: 0, consecutiveSuccesses: 0,
    latencyMs: 38, lastRoundOk: true, failingTargetIds: [], changedAt: null, history: [] }],
  availableNodeIds: [node.id], lastRoundAt: '2026-01-01T00:00:00.000Z', lastSwitch: null, pendingSwitch: null,
}

test('all application routes render without runtime errors or page-level horizontal overflow at 320px', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewportSize({ width: 320, height: 780 })
  await installApiMocks(page)

  for (const path of routes) {
    await page.goto(path)
    await expect(page.locator('h1').first()).toBeVisible()
    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }))
    expect(scroll.width, `${path} should not force page-level horizontal scrolling`).toBeLessThanOrEqual(scroll.viewport)
  }
  expect(errors).toEqual([])
})

test('navigation remains visible and appearance controls remain keyboard-accessible', async ({ page }) => {
  await installApiMocks(page)
  await page.goto('/')
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.locator('aside[aria-label="侧边栏"]')).toBeVisible()
  await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden()
  const sidebar = await page.getByRole('complementary', { name: '侧边栏' }).boundingBox()
  const main = await page.getByRole('main').boundingBox()
  expect(sidebar?.x).toBe(0)
  expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(main!.x)
  await page.getByRole('link', { name: '分组' }).click()
  await expect(page.getByRole('heading', { name: '分组', level: 1 })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开导航' }).click()
  await expect(page.locator('dialog[open]')).toBeVisible()
  const drawer = page.getByRole('dialog', { name: '导航' })
  await drawer.getByLabel('外观').selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await drawer.getByLabel('外观').selectOption('light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0)
  await page.keyboard.press('Escape')
  await expect(drawer).not.toBeVisible()
  await expect(page.getByRole('button', { name: '打开导航' })).toBeFocused()
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await page.getByRole('link', { name: '设备', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设备', level: 1 })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: '打开导航' })).toHaveAttribute('aria-expanded', 'false')
})

test('page data loading uses a reduced-motion-aware content skeleton', async ({ page }) => {
  await installApiMocks(page)
  let releaseNodes!: () => void
  const nodesReady = new Promise<void>((resolve) => { releaseNodes = resolve })
  await page.route('**/api/v1/nodes', async (route) => {
    await nodesReady
    await route.fulfill({ json: { items: [] } })
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/nodes')
  const status = page.getByRole('status', { name: '正在加载' })
  await expect(status).toBeVisible()
  await expect(status).toHaveAttribute('aria-busy', 'true')
  const skeletonLine = status.locator('[aria-hidden="true"] > span').first()
  await expect(skeletonLine).toBeVisible()
  expect(await skeletonLine.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await expect(status).toHaveText('正在加载')
  releaseNodes()
  await expect(status).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '节点', level: 1 })).toBeVisible()
})

test('server field errors select the correct form tab and focus the invalid field', async ({ page }) => {
  await installApiMocks(page)
  await page.goto('/groups/new')
  await expect(page.locator('#switching')).toBeHidden()
  await page.getByLabel('名称').fill('回归测试')
  await page.getByLabel('selector tag').fill('ui-test')
  await page.getByRole('button', { name: '创建分组' }).click()
  await expect(page.getByRole('tab', { name: '切换', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#switching')).toBeVisible()
  await expect(page.locator('[data-field="failThreshold"] input')).toBeFocused()
  await expect(page.getByRole('alert').filter({ hasText: '没有保存' })).toBeVisible()
})

test('live outlet details disclose one level at a time on overview and device routes', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/')
  await expect(page.getByText('当前出口：东京节点')).toHaveCount(0)
  await page.getByRole('button', { name: '查看 测试设备 默认分组 出口' }).click()
  await expectDialogCentered(page.getByRole('dialog', { name: '测试设备 · 默认分组' }))
  await expect(page.getByText('当前出口：东京节点')).toBeVisible()
  await page.getByText('候选节点与探测详情').click()
  const candidateDialog = page.getByRole('dialog', { name: '默认分组 · 候选节点' })
  await expect(candidateDialog).toBeVisible()
  await expectDialogCentered(candidateDialog)
  const nodeRow = candidateDialog.getByText('东京节点').first()
  await expect(nodeRow).toBeVisible()
  await candidateDialog.getByRole('button', { name: '详情' }).click()
  await expect(page.getByText('可用，延迟中位数 38 ms')).toBeVisible()
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport)

  await page.goto('/devices/device-1')
  await expect(page.getByRole('heading', { name: '测试设备', level: 1 })).toBeVisible()
  await expect(page.getByText('当前出口：东京节点')).toBeVisible()
  await expect(page.getByRole('table', { name: '「默认分组」的候选节点' })).toBeHidden()
  await page.getByText('候选节点与探测详情').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('table', { name: '「默认分组」的候选节点' })).toBeVisible()
  await expect(page.getByRole('table', { name: '「默认分组」的候选节点' })).toHaveCount(1)
})

test('API failures stay visible with a working retry state', async ({ page }) => {
  await installApiMocks(page, { failNodes: true })
  await page.goto('/nodes')
  await expect(page.getByRole('alert')).toContainText('没能加载数据')
  await expect(page.getByRole('alert')).toContainText('模拟服务不可用')
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible()
})

test('overview groups offline issues by device and reports devices without runtimes', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.route('**/api/v1/devices', (route) => route.fulfill({ json: { items: [
    { ...device, online: false },
    { ...device, id: 'new-device', name: '未上报设备', online: false },
  ] } }))
  await page.route('**/api/v1/runtime*', (route) => route.fulfill({ json: { items: [
    { ...runtime, state: 'stale' }, { ...runtime, groupId: 'group-2', state: 'stale' },
  ] } }))
  await page.goto('/')
  const attention = page.locator('#attention')
  await expect(attention.getByRole('listitem')).toHaveCount(2)
  await expect(attention.getByText('设备离线', { exact: true })).toHaveCount(2)
  await expect(attention.getByRole('link', { name: '未上报设备' })).toBeVisible()
})

test('overview keeps sing-box failures visible before any runtime is reported', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.route('**/api/v1/devices', (route) => route.fulfill({ json: { items: [{ ...device, singboxError: '监听端口被占用' }] } }))
  await page.route('**/api/v1/runtime*', (route) => route.fulfill({ json: { items: [] } }))
  await page.goto('/')
  await expect(page.locator('#attention').getByText('监听端口被占用')).toBeVisible()
})

test('node search filters records and restores them when cleared', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.goto('/nodes')
  const search = page.getByRole('searchbox', { name: '搜索名称、地区或地址' })
  const list = page.getByRole('list', { name: '代理节点列表' })
  await search.fill('PROXY.EXAMPLE.COM')
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await search.fill('无匹配结果')
  await expect(list.getByRole('listitem')).toHaveCount(0)
  await expect(page.getByText('无匹配节点')).toBeVisible()
  await page.getByRole('button', { name: '清除搜索' }).click()
  await expect(list.getByRole('listitem')).toHaveCount(1)
})

test('node records keep details out of the list and open them in a focused dialog', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.goto('/nodes')
  const list = page.getByRole('list', { name: '代理节点列表' })
  await expect(list.getByRole('button', { name: '详情' })).toBeVisible()
  await expect(list.locator('details')).toHaveCount(0)
  await list.getByRole('button', { name: '详情' }).click()
  const dialog = page.getByRole('dialog', { name: '东京节点' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('proxy.example.com:443')).toBeVisible()
  await expectDialogCentered(dialog)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(list.getByRole('button', { name: '详情' })).toBeFocused()
})

for (const theme of ['light', 'dark']) {
  test(`shared controls use compact corners and distinguish switch states in ${theme}`, async ({ page }, testInfo) => {
    await installApiMocks(page, { populated: true })
    await page.addInitScript((value) => localStorage.setItem('singweb.theme', value), theme)
    const source = {
      id: 'source-1', name: '测试订阅', enabled: true, url: 'https://example.com/subscription',
      lastFetchedAt: '2026-01-01T00:00:00.000Z', lastError: '没有解析出节点', nodeCount: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    let secondEnabled = false
    await page.route('**/api/v1/sources', (route) => route.fulfill({ json: { items: [source] } }))
    await page.route('**/api/v1/sources/source-1/refresh', (route) => route.fulfill({ json: { ok: false, error: source.lastError, nodeCount: 2 } }))
    await page.route('**/api/v1/nodes', (route) => route.fulfill({ json: { items: [node, { ...node, id: 'node-2', tag: '备用节点', enabled: secondEnabled }] } }))
    await page.route('**/api/v1/nodes/node-2', (route) => {
      secondEnabled = route.request().postDataJSON().enabled
      return route.fulfill({ json: { ...node, id: 'node-2', tag: '备用节点', enabled: secondEnabled } })
    })
    await page.goto('/nodes')
    const list = page.getByRole('list', { name: '代理节点列表' })
    await expect(list.getByRole('switch')).toHaveCount(2)
    for (const control of await list.getByRole('switch').all()) {
      const appearance = await control.evaluate((element) => {
        const track = getComputedStyle(element)
        const thumb = getComputedStyle(element.firstElementChild!)
        const context = document.createElement('canvas').getContext('2d')!
        const luminance = (color: string) => {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
            const value = v / 255
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
          })
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        }
        const a = luminance(track.backgroundColor)
        const b = luminance(thumb.backgroundColor)
        return { contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), radius: track.borderRadius, transform: thumb.transform }
      })
      expect(appearance.radius).toBe('6px')
      expect(appearance.contrast).toBeGreaterThanOrEqual(3)
      expect(appearance.transform).toBe(await control.getAttribute('aria-checked') === 'true' ? 'matrix(1, 0, 0, 1, 16, 0)' : 'none')
    }
    const chips = page.getByRole('group', { name: '节点状态' })
    for (const chip of await chips.getByRole('button').all()) {
      await expect(chip).toHaveCSS('border-radius', '6px')
      await expect(chip).toHaveCSS('box-shadow', 'none')
    }
    await chips.getByRole('button', { name: '已停用 1' }).click()
    await expect(list.getByRole('listitem')).toHaveCount(1)
    await chips.getByRole('button', { name: '全部 2' }).click()
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(page.getByText('拉取失败', { exact: true }).locator('..')).toHaveCSS('border-radius', '6px')
    await expect(page.getByRole('button', { name: '导入节点' })).toHaveCSS('border-radius', '6px')
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const toast = page.getByRole('status').filter({ hasText: '拉取「测试订阅」失败' }).locator('div').first()
    await expect(toast).toBeVisible()
    await expect(toast).toHaveCSS('border-radius', '6px')
    await page.screenshot({ path: testInfo.outputPath(`controls-${theme}.png`), fullPage: true })
    await page.getByRole('button', { name: '关闭提示' }).click()
    const toggle = list.getByRole('switch', { name: '启用 备用节点' })
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(list.getByRole('switch', { name: '停用 备用节点' })).toHaveAttribute('aria-checked', 'true')
    await expect(list.getByRole('switch', { name: '停用 备用节点' })).toBeFocused()
    await page.getByRole('button', { name: '导入节点' }).click()
    const dialog = page.getByRole('dialog', { name: '导入节点' })
    await expect(dialog).toHaveCSS('border-radius', '6px')
    await expect(dialog.getByLabel('名称')).toHaveCSS('border-radius', '6px')
    await expectDialogCentered(dialog)
    await page.setViewportSize({ width: 320, height: 780 })
    await expectDialogCentered(dialog)
    await page.setViewportSize({ width: 1280, height: 300 })
    await expectDialogCentered(dialog)
    const footer = dialog.getByRole('button', { name: '添加订阅' })
    await footer.scrollIntoViewIfNeeded()
    await expect(footer).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath(`centered-dialog-${theme}.png`) })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '导入节点' })).toBeFocused()
    await page.getByRole('button', { name: '重置链接' }).click()
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)
    const confirmation = page.getByRole('dialog', { name: '重置订阅链接？' })
    await expectDialogCentered(confirmation)
    await confirmation.getByRole('button', { name: '取消' }).click()
    await expect(page.getByRole('button', { name: '重置链接' })).toBeFocused()
  })
}

test('device details retain metadata and fit outlet controls in the first viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await installApiMocks(page, { populated: true })
  await page.goto('/devices/device-1')
  await expect(page.locator('main > header').getByText('test-host')).toBeVisible()
  await expect(page.getByText('当前出口：东京节点')).toBeInViewport()
})

test('login remains usable without a session and reports rejected credentials', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'EventSource', { value: undefined }))
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { user: null } }))
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ status: 401, json: { message: '账号或密码不正确' } }))
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'singweb' })).toBeVisible()
  await page.getByLabel('用户名').fill('tester')
  await page.getByLabel('密码').fill('incorrect')
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('alert')).toContainText('账号或密码不正确')
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport)
})

test('group creation keeps the list mounted, supports keyboard tabs and confirms discarded changes', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.goto('/groups')
  const trigger = page.getByRole('link', { name: '新建分组' })
  await page.locator('main h1').evaluate((element) => element.setAttribute('data-preserved', 'true'))
  await trigger.click()
  const editor = page.getByRole('dialog', { name: '新建分组', exact: true })
  await expectDialogCentered(editor)
  await expect(page.locator('main h1')).toHaveText('分组')
  await expect(page.locator('main h1')).toHaveAttribute('data-preserved', 'true')
  await expect(editor.getByLabel('名称', { exact: true })).toBeFocused()
  await editor.getByLabel('名称', { exact: true }).fill('未保存草稿')
  await editor.getByRole('tab', { name: '基本', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(editor.getByRole('tab', { name: '流量', exact: true })).toBeFocused()
  await expect(editor.getByRole('tabpanel', { name: '流量', exact: true })).toBeVisible()
  await page.keyboard.press('End')
  await expect(editor.getByRole('tab', { name: '预览', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('未保存草稿')
  await page.keyboard.press('Escape')
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？' })
  await expectDialogCentered(confirmation)
  await confirmation.getByRole('button', { name: '取消' }).click()
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue('未保存草稿')
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  await confirmation.getByRole('button', { name: '放弃修改' }).click()
  await expect(page).toHaveURL(/\/groups$/)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('editing a group from a device preserves that device page and its trigger', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.goto('/devices/device-1')
  await page.locator('main h1').evaluate((element) => element.setAttribute('data-preserved', 'true'))
  const trigger = page.getByRole('link', { name: '编辑分组', exact: true })
  await trigger.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => scrollY)
  await trigger.click()
  const editor = page.getByRole('dialog', { name: '编辑 默认分组' })
  await expectDialogCentered(editor)
  await expect(page).toHaveURL(/\/devices\/device-1\/groups\/group-1\/edit$/)
  await expect(page.locator('main h1')).toHaveText('测试设备')
  await expect(page.locator('main h1')).toHaveAttribute('data-preserved', 'true')
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/devices\/device-1$/)
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => scrollY)).toBe(scroll)
  await page.goto('/devices/device-1/groups/group-1/edit')
  await expect(editor).toBeVisible()
  await expect(page.locator('main h1')).toHaveText('测试设备')
  await expect(page.locator('details, summary')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('main')).toBeFocused()
})

test('group deletion confirms its impact and restores focus when its trigger disappears', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  let deleted = false
  await page.route('**/api/v1/groups/group-1', async (route) => {
    deleted = true
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/v1/groups', (route) => route.fulfill({ json: { items: deleted ? [] : [group] } }))
  await page.goto('/groups')
  await page.getByRole('link', { name: '编辑默认分组' }).click()
  await page.getByRole('dialog', { name: '编辑 默认分组' }).getByRole('button', { name: '删除分组' }).click()
  const confirmation = page.getByRole('dialog', { name: '删除分组「默认分组」？' })
  await expectDialogCentered(confirmation)
  await expect(confirmation).toContainText('会被移除')
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page).toHaveURL(/\/groups$/)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.getByRole('main')).toBeFocused()
})

test('group saving closes the editor and refreshes the preserved list', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  let saved = group
  await page.route('**/api/v1/groups', async (route) => {
    if (route.request().method() === 'POST') {
      saved = { ...group, ...route.request().postDataJSON() }
      await route.fulfill({ json: saved })
    } else await route.fulfill({ json: { items: [saved] } })
  })
  await page.goto('/groups')
  await page.getByRole('link', { name: '新建分组' }).click()
  const editor = page.getByRole('dialog', { name: '新建分组', exact: true })
  await editor.getByLabel('名称', { exact: true }).fill('新分组')
  await editor.getByLabel('selector tag').fill('new-group')
  await editor.getByRole('button', { name: '创建分组' }).click()
  await expect(page).toHaveURL(/\/groups$/)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await expect(page.getByRole('link', { name: '新分组', exact: true })).toBeVisible()
})

test('event filters use a modal and preserve selected URL filters when reopened', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.goto('/events')
  await page.getByRole('button', { name: '筛选事件', exact: true }).click()
  const filters = page.getByRole('dialog', { name: '筛选事件' })
  await expectDialogCentered(filters)
  await filters.getByLabel('设备', { exact: true }).selectOption(device.id)
  await filters.getByLabel('类型', { exact: true }).selectOption('fault')
  await filters.getByRole('button', { name: '完成' }).click()
  await expect(page.getByRole('button', { name: '筛选已启用' })).toBeFocused()
  await expect(page).toHaveURL(/device=device-1&type=fault/)
  await page.getByRole('button', { name: '筛选已启用' }).click()
  await expect(filters.getByLabel('设备', { exact: true })).toHaveValue(device.id)
  await filters.getByRole('button', { name: '清除筛选' }).click()
  await expect(filters.getByLabel('设备', { exact: true })).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(page.locator('details, summary')).toHaveCount(0)
})

test('nested rule creation remains accessible inside the group modal at 320px', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/groups/group-1')
  const editor = page.getByRole('dialog', { name: '编辑 默认分组' })
  await editor.getByRole('tab', { name: '规则', exact: true }).click()
  await editor.getByRole('button', { name: '添加规则' }).click()
  const item = page.getByRole('menuitem', { name: /^TCP/ })
  await expect(item).toBeInViewport()
  await item.click()
  const rule = page.getByRole('dialog', { name: /^添加 TCP.*规则$/ })
  await expectDialogCentered(rule)
  await expect(rule.getByRole('button', { name: '添加规则', exact: true })).toBeInViewport()
  await page.keyboard.press('Escape')
  await expect(editor.getByRole('button', { name: '添加规则' })).toBeFocused()
  await expect(page.locator('details, summary')).toHaveCount(0)
})

test('device install options use a nested modal and restore focus to enrollment', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.route('**/api/v1/devices/enroll', (route) => route.fulfill({ json: {
    id: 'test-enroll', token: 'fake-ui-regression-token', expiresAt: new Date(Date.now() + 1800000).toISOString(),
  } }))
  await page.route('**/api/v1/devices/enroll/test-enroll', (route) => route.fulfill({ json: { state: 'pending' } }))
  await page.setViewportSize({ width: 320, height: 780 })
  await page.goto('/devices')
  await page.getByRole('button', { name: '接入新设备' }).click()
  const enroll = page.getByRole('dialog', { name: '接入新设备' })
  await expectDialogCentered(enroll)
  await enroll.getByRole('button', { name: '安装选项与日志' }).click()
  const options = page.getByRole('dialog', { name: '安装选项与日志' })
  await expectDialogCentered(options)
  await page.keyboard.press('Escape')
  await expect(enroll.getByRole('button', { name: '安装选项与日志' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '接入新设备' })).toBeFocused()
  await expect(page.locator('details, summary')).toHaveCount(0)
})

test('target creation and editing preserve the target list behind a centered modal', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  await page.goto('/targets')
  await page.getByRole('button', { name: '添加目标' }).click()
  await page.getByRole('menuitem', { name: /^TCP/ }).click()
  const create = page.getByRole('dialog', { name: /^添加 TCP.*目标$/ })
  await expectDialogCentered(create)
  await expect(page.locator('main h1')).toHaveText('探测目标')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '添加目标' })).toBeFocused()
  const trigger = page.getByRole('button', { name: '编辑 测试服务' })
  await trigger.click()
  await expectDialogCentered(page.getByRole('dialog', { name: '编辑「测试服务」' }))
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('device config is fetched only when its preview modal is opened', async ({ page }) => {
  await installApiMocks(page, { populated: true })
  let previews = 0
  await page.route('**/api/v1/config/preview', async (route) => {
    previews++
    await route.fulfill({ json: { config: {}, warnings: [] } })
  })
  await page.goto('/devices/device-1')
  const trigger = page.getByRole('button', { name: '查看配置', exact: true })
  await expect(trigger).toBeVisible()
  expect(previews).toBe(0)
  await trigger.click()
  const preview = page.getByRole('dialog', { name: '测试设备 的 sing-box 配置' })
  await expectDialogCentered(preview)
  await expect.poll(() => previews).toBe(1)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

for (const width of [320, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`populated pages and modal sections render in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await installApiMocks(page, { populated: true })
      await page.addInitScript((value) => localStorage.setItem('singweb.theme', value), theme)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      for (const path of ['/', '/devices', '/devices/device-1', '/groups', '/groups/group-1', '/targets', '/nodes', '/matrix', '/events']) {
        await page.goto(path)
        await expect(page.locator('h1').first()).toBeVisible()
        await expect(page.locator('details, summary')).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        if (path === '/groups') {
          const colors = await page.getByRole('link', { name: '新建分组' }).evaluate((element) => {
            const style = getComputedStyle(element)
            return { text: style.color, background: style.backgroundColor }
          })
          expect(colors.text).not.toBe(colors.background)
        }
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: path }).toBeLessThanOrEqual(0)
        await page.screenshot({ path: testInfo.outputPath(`${path === '/' ? 'overview' : path === '/groups/group-1' ? 'editor' : path.slice(1).replaceAll('/', '-')}.png`), fullPage: true })
        if (path === '/groups/group-1') {
          const editor = page.getByRole('dialog', { name: '编辑 默认分组' })
          await expectDialogCentered(editor)
          for (const name of ['流量', '节点', '规则', '切换', '预览']) {
            await editor.getByRole('tab', { name, exact: true }).click()
            if (name === '切换') await editor.locator('#all-fail').scrollIntoViewIfNeeded()
            await expect(editor.getByRole('tab', { name, exact: true })).toBeInViewport()
            await expect(editor.getByRole('button', { name: '保存修改' })).toBeInViewport()
            expect(await editor.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
            await expectDialogCentered(editor)
            await page.screenshot({ path: testInfo.outputPath(`editor-${name}.png`) })
          }
        }
      }
      expect(errors).toEqual([])
    })
  }
}
