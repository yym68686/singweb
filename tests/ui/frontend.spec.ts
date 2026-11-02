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

test('navigation and appearance controls remain keyboard-accessible and nested', async ({ page }) => {
  await installApiMocks(page)
  await page.goto('/')
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(page.locator('aside[aria-label="侧边栏"]')).toBeVisible()
  await expect(page.getByRole('button', { name: '打开导航' })).toBeHidden()
  const sidebar = await page.getByRole('complementary', { name: '侧边栏' }).boundingBox()
  const main = await page.getByRole('main').boundingBox()
  expect(sidebar?.x).toBe(0)
  expect(sidebar!.x + sidebar!.width).toBeLessThanOrEqual(main!.x)
  await page.locator('summary').filter({ hasText: '配置' }).click()
  await page.getByRole('link', { name: '分组' }).click()
  await expect(page.getByRole('heading', { name: '分组', level: 1 })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '打开导航' }).click()
  await expect(page.locator('dialog[open]')).toBeVisible()
  await page.getByRole('dialog', { name: '导航' }).locator('summary').filter({ hasText: '外观' }).click()
  const drawer = page.getByRole('dialog', { name: '导航' })
  await drawer.getByLabel('深色').check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await drawer.getByLabel('浅色').check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect((await drawer.boundingBox())?.x).toBe(0)
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

test('server field errors reveal collapsed sections and focus the invalid field', async ({ page }) => {
  await installApiMocks(page)
  await page.goto('/groups/new')
  await expect(page.locator('#switching')).not.toHaveAttribute('open', '')
  await page.getByLabel('名称').fill('回归测试')
  await page.getByLabel('selector tag').fill('ui-test')
  await page.getByRole('button', { name: '创建分组' }).click()
  await expect(page.locator('#switching')).toHaveAttribute('open', '')
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

for (const width of [320, 1280]) {
  for (const theme of ['light', 'dark']) {
    test(`populated pages and disclosures render in ${theme} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await installApiMocks(page, { populated: true })
      await page.addInitScript((value) => localStorage.setItem('singweb.theme', value), theme)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      for (const path of ['/', '/devices', '/devices/device-1', '/groups', '/groups/group-1', '/targets', '/nodes', '/matrix', '/events']) {
        await page.goto(path)
        await expect(page.locator('h1').first()).toBeVisible()
        // Visual QA opens all levels. Dedicated tests above cover user-driven activation.
        await page.locator('main details').evaluateAll((details) => details.forEach((detail) => { (detail as HTMLDetailsElement).open = true }))
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
      }
      expect(errors).toEqual([])
    })
  }
}
