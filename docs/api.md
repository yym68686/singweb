# 管理服务接口

前端在 `VITE_API_MODE=http` 时通过这些接口和管理服务通信。字段的类型定义在 [`src/api/types.ts`](../src/api/types.ts)。演示模式的模拟引擎 [`src/api/mock/engine.ts`](../src/api/mock/engine.ts) 按本文的规则实现，可以当作参考实现。

## 通用约定

- 接口前缀默认是 `/api/v1`，由 `VITE_API_BASE` 设置。下文的路径都省略前缀。
- 请求和响应都是 JSON。时间一律用 ISO 8601 字符串，例如 `2026-09-30T08:15:00.000Z`。
- 路径里的 id 会做 URL 编码。查询参数为空时不发送；列表参数用逗号分隔。
- 前端本身不处理登录。请求会带上同源的 Cookie，需要登录时由管理服务或它前面的反向代理处理。
- 建议页面和接口用同一个源，比如都由管理服务提供，或者经过同一个反向代理。跨源时请求不带 Cookie，管理服务还要配置 CORS。
- 没有内容的成功响应建议返回 `204 No Content`，空的 `200` 前端也能处理。
- 其他成功响应的内容必须是 JSON。不是 JSON 时，前端提示检查接口地址（`VITE_API_BASE`）和反向代理设置。常见原因是接口前缀配错，或者反向代理把请求回退成了 `index.html`。
- 出错时返回非 2xx 状态码和下面的响应体：

  ```json
  { "message": "selector tag 只能包含字母、数字、- 和 _。", "field": "selectorTag" }
  ```

  - `message` 会原样显示给用户，应该用一句中文说明出了什么问题、怎么解决。
  - `field` 可选。表单提交出错时，前端把 `message` 显示在这个字段旁边，并把焦点移过去。能用的字段名见[探测目标](#探测目标)和[分组](#分组)的校验规则。
  - 响应体不是 JSON 时，前端显示“管理服务返回 {状态码}”；请求没能发出去时，显示“连不上管理服务”。
- 用到的状态码：`400` 输入有误；`404` 对象不存在；`409` 当前状态下不能执行，例如设备离线、目标正被分组规则使用。

## 接口一览

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/devices` | | `Device[]` |
| GET | `/devices/{id}` | | `Device` |
| POST | `/devices/{id}/probe` | | `204` |
| POST | `/devices/{deviceId}/groups/{groupId}/pending/{id}/retry` | | `{ "ok": true }` |
| POST | `/devices/{deviceId}/groups/{groupId}/pin` | `{ "nodeId": string \| null }` | `GroupRuntime` |
| GET | `/nodes` | | `ProxyNode[]` |
| PATCH | `/nodes/{id}` | `{ "enabled": boolean }` | `ProxyNode` |
| GET | `/sources` | | `NodeSource[]` |
| POST | `/sources` | `{ "name": string, "url": string }` | `NodeSource` |
| PATCH | `/sources/{id}` | `{ "name"?: string, "url"?: string, "enabled"?: boolean }` | `NodeSource` |
| POST | `/sources/{id}/refresh` | | `{ "ok": true, "requestedAt": string }` |
| DELETE | `/sources/{id}` | | `204` |
| GET | `/targets` | | `Target[]` |
| POST | `/targets` | `TargetInput` | `Target` |
| PUT | `/targets/{id}` | `TargetInput` | `Target` |
| DELETE | `/targets/{id}` | | `204` |
| GET | `/groups` | | `Group[]` |
| GET | `/groups/{id}` | | `Group` |
| POST | `/groups` | `GroupInput` | `Group` |
| PUT | `/groups/{id}` | `GroupInput` | `Group` |
| DELETE | `/groups/{id}` | | `204` |
| GET | `/runtime?deviceId=` | | `GroupRuntime[]` |
| GET | `/probes?deviceId=&nodeId=` | | `ProbeCell[]` |
| GET | `/events?…` | | `EventPage` |
| GET | `/stream` | | `text/event-stream` |

## 设备

设备由 Agent 注册，前端只读。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `name` | string | 显示名称 |
| `hostname` | string | |
| `platform` | `macos` \| `linux` | |
| `osVersion` | string | macOS 上是系统版本号，如 `15.6`；Linux 上是 os-release 里的发行版和版本，如 `Ubuntu 24.04` |
| `agentVersion` | string | |
| `singboxVersion` | string | 低于 `1.11.0` 时，前端提示版本过低 |
| `online` | boolean | Agent 是否还在上报 |
| `lastSeenAt` | string | Agent 最后一次上报的时间 |
| `clashApi` | string | sing-box Clash API 的地址，如 `127.0.0.1:9090` |
| `probeInbound` | string | 探测用的本地 socks 入站，如 `127.0.0.1:17891` |
| `dataDir` | string | Agent 存放阻断规则集等文件的目录 |
| `note` | string，可选 | 备注 |

管理服务一段时间收不到上报，就把设备标记为离线，并记一条 `device-offline` 事件（演示模式是 90 秒）；重新收到上报时标记为在线，记 `device-online`。设备离线时：

- `GET /runtime` 仍返回它最后上报的状态，`state` 为 `stale`。
- 立即探测、固定节点和选择节点返回 `409`。

### 立即探测

`POST /devices/{id}/probe` 让 Agent 马上对这台设备上按规则自动切换的分组探测一轮，**这一轮完成后**再返回 `204`，前端随后提示“已完成一轮探测”。判定和切换的规则与定时探测相同。

手动选择的分组不探测。设备上只有手动选择的分组时，这个接口什么也不做，直接返回 `204`；前端这时也不显示“立即探测”按钮。

设备不存在返回 `404`，设备离线返回 `409`。

### 固定节点和选择节点

`POST /devices/{deviceId}/groups/{groupId}/pin`

同一个接口，在两种分组里含义不同。

按规则自动切换的分组（固定节点）：

- `{ "nodeId": "hk-02" }`：这台设备上的这个分组固定走 HK-02，暂停自动切换，记 `pin` 事件。固定到不可用的节点也可以，前端在选项里会标出哪些节点不可用。
- `{ "nodeId": null }`：取消固定，记 `unpin` 事件，立刻按当前的探测结果重新选择节点。

手动选择的分组（选择节点）：

- `{ "nodeId": "tw-01" }`：切到 TW-01。出口变了时记 `switch` 事件，例如“手动切到 TW-01”。
- `{ "nodeId": null }`：不再指定节点，改走第一个启用的候选节点，例如“改回第一个启用的候选节点 HK-01”。

两种分组相同的部分：

- 返回更新后的 `GroupRuntime`。请求的状态和现在一样时，什么也不改，也不记事件。
- 错误：设备没有应用这个分组，`404`；设备离线，`409`；节点不是这个分组的候选节点，或者已经停用，`400`。

固定期间的行为见[固定](#固定)，手动选择的分组见[手动选择](#手动选择)。

### 待执行的操作

网页上点的切换不会立刻生效：管理服务把这一条写进队列，Agent 下一轮上报时领走、执行、然后确认。
每次 `POST /agent/report` 的响应里带 `pending`，是这台设备还没执行的条目。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `deviceId` | string | |
| `groupId` | string | |
| `nodeId` | string \| null | 要切到的节点；`null` 表示取消固定或不再指定节点 |
| `reason` | `web-pin` \| `web-unpin` \| `manual-probe` | 这条待办从哪来 |
| `attempts` | number | Agent 报告过几次失败 |
| `lastError` | string \| null | 最近一次失败的原因 |
| `failedAt` | string \| null | 达到重试上限的时间；有值时这条已经放弃，不再发给 Agent |
| `createdAt` | string | |

设备页的每个分组上用 `pendingSwitch` 字段带出来，可能的值：

- `queued`：已排队，等设备下一轮上报。
- `switching`：Agent 报告过一次失败，还会再重试。
- `failed`：连续 3 次失败后放弃，同时记一条 `switch-failed` 事件，事件里带着最后一次的原因。

`POST /devices/{deviceId}/groups/{groupId}/pending/{id}/retry` 把一条 `failed` 的待办退回队列，
清掉失败计数，记一条 `switch` 事件。适合修好原因之后（比如把节点加回 selector）再试一次。
这条待办已经被清掉或删除时返回 `404`。

## 节点

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `tag` | string | sing-box 出站的 tag，界面上显示的节点名 |
| `protocol` | `shadowsocks` \| `vmess` \| `vless` \| `trojan` \| `hysteria2` \| `tuic` | |
| `server` | string | |
| `port` | number | |
| `region` | string | 地区，如“香港” |
| `enabled` | boolean | 停用后不参与任何分组，也不再探测 |
| `source` | string | 节点来自哪里，如“订阅「主力」” |

节点来自设备的 sing-box 配置或订阅，前端只能用 `PATCH /nodes/{id}` 启用或停用。按条件自动加入的分组用 `region`、`protocol` 和 `tag` 挑选节点，见[候选节点](#候选节点)。

停用一个节点时：

- 用到它的分组立即重新选择节点。它正是当前出口时，按规则自动切换的分组切到下一个可用节点，手动选择的分组改走第一个启用的候选节点。
- 固定在它上面的分组自动取消固定，记 `unpin` 事件；手动选择的分组选中了它的，这个选择也清掉。
- 记一条 `node-changed` 事件，例如“停用了节点 HK-01，它不再参与任何分组，也不再探测”。节点只用在手动选择的分组里时，不提探测。

重新启用后：

- 节点在各个自动分组里的健康状态从“待探测”开始。
- 停用时清掉的固定和选择不会恢复。
- 没有选过节点的手动分组，如果它排在启用的候选节点第一位，出口会改回它，记“没有选过节点，改走第一个启用的候选节点 HK-01”。

## 订阅来源

订阅来源是一条订阅链接。链接和它里面的 token 只存在管理服务的数据库里，由 Agent 在下一轮上报时领走，
管理服务自己不去访问订阅站——真正联网取内容的一直是设备上的 Agent。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `name` | string | 订阅名称，最多 60 个字 |
| `url` | string | 完整的订阅链接，含 token |
| `enabled` | boolean | 停用后设备不再拉取它，已经导入的节点保留 |
| `lastFetchedAt` | string \| null | 最近一次拉取成功的时间 |
| `lastError` | string \| null | 最近一次拉取失败的原因 |
| `nodeCount` | number | 最近一次拉取解析出的节点数 |
| `createdAt` | string | |
| `refreshRequested` | boolean | 用户点了「立即刷新」，设备还没来领 |

`url` 只以 http 或 https 开头、必须有主机名，否则返回 `400`。

**拉取的节奏由 Agent 掌握。** Agent 每 6 小时重新取一次订阅内容，失败后 5 分钟重试；
用户在网页上点了「立即刷新」，或者这个订阅从没拉过，Agent 就立刻取一次，不等这个周期。
`POST /sources/{id}/refresh` 只打一个时间戳，不自己去联网，所以响应里没有新节点：
要等设备下一轮上报，`lastFetchedAt` 和 `nodeCount` 才会变。停用的订阅调它返回 `409`。

**删除订阅会连它导入的节点一起删。** 这些节点正被分组当候选节点用时，那台设备上会少一截出口，
界面在确认框里提示数量和影响。

**界面显示地址时会隐去查询参数的值**，例如 `https://example.com/sub?token=••••`。
完整的链接仍然会被完整地存进数据库、完整地发给 Agent；隐去只是为了截图和录屏不泄露 token。

## 探测目标

探测目标是分组规则探测的对象。每条分组规则引用一个目标，同一个目标可以被多个分组共用。目标分三种，用 `kind` 区分：

| `kind` | 界面上显示 | 检查什么 |
| --- | --- | --- |
| `ssh` | SSH 探测 | 经过节点连接 SSH 服务，读到标识或完成握手，不登录 |
| `http` | HTTP 探测 | 经过节点请求一个网址，检查状态码和响应内容。能发现被网站拒绝的节点，比如按地区返回 403 |
| `tcp` | TCP 探测 | 只检查能否经过节点连上目标端口，适合数据库、远程桌面这类服务 |

三种目标共有的字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 管理服务生成 |
| `kind` | `ssh` \| `http` \| `tcp` | 创建后不能修改 |
| `name` | string | |
| `timeoutMs` | number | 整次探测的超时 |
| `note` | string，可选 | |

`TargetInput` 是去掉 `id` 的 `Target`。

### SSH 探测

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `host` | string | 域名或 IP |
| `port` | number | |
| `level` | `banner` \| `handshake` | 探测做到哪一步，见下表 |
| `hostKey` | string | 期望的主机密钥指纹，空字符串表示不校验 |

| `level` | 界面上显示 | 做到哪一步 |
| --- | --- | --- |
| `banner` | SSH 标识 | 读到服务端发来的 `SSH-2.0-` 标识行，能区分 SSH 服务和别的服务 |
| `handshake` | SSH 握手 | 完成密钥交换，拿到主机密钥。`hostKey` 不为空时核对指纹，不一致算失败 |

两种级别都不进入 SSH 认证阶段，不发送账号或密钥。只想检查端口能不能连上时，用 TCP 探测。

### HTTP 探测

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 要请求的网址，`http://` 或 `https://` 开头 |
| `expectStatus` | number[] | 算作通过的状态码。空数组表示 200–399 都算通过 |
| `keyword` | string \| null | 不为 `null` 时，响应内容里还要包含这段文字 |

```json
{
  "id": "openai-api",
  "kind": "http",
  "name": "OpenAI 接口",
  "url": "https://api.openai.com/v1/models",
  "expectStatus": [401],
  "keyword": null,
  "timeoutMs": 6000,
  "note": "不带密钥时正常返回 401；不支持的地区返回 403"
}
```

不带密钥请求 OpenAI 的接口，正常情况下返回 401，在不支持的地区返回 403。把期望的状态码设为 401，就能把这些地区的节点排除掉。请求的具体做法见[探测](#探测)。

### TCP 探测

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `host` | string | 域名或 IP |
| `port` | number | |

很多代理协议在节点真正连上目标之前，就告诉 Agent 已经连上了，所以目标端口被封时 TCP 探测也可能通过。TCP 探测主要反映节点本身能不能用，能用 SSH 或 HTTP 探测的服务，优先用它们。

### 目标的校验规则

校验规则（第一列就是出错时的 `field`）：

| 字段 | 规则 |
| --- | --- |
| `name` | 必填 |
| `host` | SSH 和 TCP：必填，只填域名或 IP，不能包含空白、`/` 或 `@` |
| `port` | SSH 和 TCP：1–65535 的整数 |
| `timeoutMs` | 500–30000 的整数 |
| `hostKey` | SSH：非空时形如 `SHA256:` 加 43 个 Base64 字符。只在 `level` 为 `handshake` 时保存，其他级别存为空字符串 |
| `url` | HTTP：以 `http://` 或 `https://` 开头的有效网址，不能带用户名和密码 |
| `expectStatus` | HTTP：100–599 的整数。保存时去掉重复的，从小到大排列 |
| `keyword` | HTTP：最多 100 个字符。保存时去掉首尾空白，空字符串存为 `null` |
| `kind` | 修改时不能变。要换类型，新建一个目标，再在分组里换用它 |

- 修改了影响探测结果的字段时，清掉这个目标原来的探测结果。SSH 是 `host`、`port`、`level` 和 `hostKey`；HTTP 是 `url`、`expectStatus` 和 `keyword`；TCP 是 `host` 和 `port`。
- 删除时如果还有分组在用，返回 `409`，`message` 里列出这些分组，例如“有分组在用它作为分组规则：「SSH 出口」、「GitHub」。先在分组里移除这条规则。”

## 分组

一个分组对应设备上 sing-box 的一个 selector 出站。`match` 决定哪些流量交给它，`candidates` 决定它可以选用哪些节点，`selection` 决定怎样选：

- `auto`（按规则自动切换）：Agent 按分组规则探测候选节点，自动选一个可用的。每条分组规则引用一个[探测目标](#探测目标)，一个分组可以叠加多条，由 `targetMode` 决定节点要通过全部规则还是任意一条。
- `manual`（手动选择）：不探测，也不自动切换，在设备页手动选择节点，和普通的 selector 一样。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 管理服务生成 |
| `name` | string | |
| `selectorTag` | string | 设备上 selector 出站的 tag |
| `deviceIds` | string[] | 应用到哪些设备 |
| `match` | `TrafficMatch` | 哪些流量交给这个分组，见[接管的流量](#接管的流量) |
| `candidates` | `Candidates` | 候选节点，见[候选节点](#候选节点) |
| `selection` | `auto` \| `manual` | 按规则自动切换，或者手动选择。新建时默认 `auto` |
| `targetIds` | string[] | 分组规则，每条引用一个探测目标 |
| `targetMode` | `all` \| `any` | `all`：通过全部规则，这一轮才算通过；`any`：通过任意一条即可。新建时默认 `all` |
| `strategy` | `priority` \| `latency` | 按优先级或按延迟选择节点。新建时默认 `priority` |
| `failThreshold` | number | 连续多少轮未通过，判为不可用。新建时默认 3 |
| `recoverThreshold` | number | 不可用的节点连续多少轮通过，才重新可用。新建时默认 2 |
| `probeIntervalSec` | number | 探测间隔。新建时默认 15 |
| `toleranceMs` | number | 按延迟选择时，别的节点至少要快这么多毫秒才切换。新建时默认 50 |
| `failback` | boolean | 按优先级选择时，更高优先级的节点恢复后是否切回。新建时默认打开 |
| `interruptExisting` | boolean | 切换时是否断开经过旧节点的已有连接。新建时默认关闭 |
| `onAllFail` | `block` \| `keep-last` \| `direct` | 候选节点全部不可用时怎么办，见[全部不可用](#全部不可用)。新建时默认 `block` |
| `updatedAt` | string | 管理服务在保存时设置 |

`GroupInput` 是去掉 `id` 和 `updatedAt` 的 `Group`。

从 `targetIds` 到 `onAllFail`，除了 `interruptExisting`，都只对按规则自动切换的分组有用。手动选择的分组保存时 `targetIds` 存为空数组；其余几项不校验，按原样保存，改回自动切换时接着用。`interruptExisting` 两种分组都适用。

一个完整的例子：

```json
{
  "id": "ai",
  "name": "AI 服务",
  "selectorTag": "ai",
  "deviceIds": ["mbp", "mini", "hz-build"],
  "match": {
    "domains": ["openai.com", "chatgpt.com", "anthropic.com", "claude.ai"],
    "domainKeywords": [],
    "ipCidrs": [],
    "ruleSets": [],
    "protocols": [],
    "ports": [],
    "processNames": []
  },
  "candidates": {
    "mode": "filter",
    "filter": { "regions": ["香港", "东京", "新加坡", "洛杉矶"], "protocols": [], "include": [], "exclude": [] }
  },
  "selection": "auto",
  "targetIds": ["openai-api", "claude-web"],
  "targetMode": "all",
  "strategy": "latency",
  "failThreshold": 2,
  "recoverThreshold": 2,
  "probeIntervalSec": 30,
  "toleranceMs": 40,
  "failback": false,
  "interruptExisting": false,
  "onAllFail": "block",
  "updatedAt": "2026-09-30T03:15:00.000Z"
}
```

这个分组接管 OpenAI、ChatGPT、Anthropic 和 Claude 的域名，候选节点是香港、东京、新加坡和洛杉矶的全部节点。节点要同时通过「OpenAI 接口」和「Claude 网页」两条规则才算可用，Agent 在可用的节点里按延迟选择。香港的节点访问 OpenAI 接口时返回 403，不会被选用。

### 接管的流量

`match` 的条件分三类。同一类里满足任意一项即可，设置了的几类要同时满足。至少要设置一类。

| 类 | 字段 | 说明 |
| --- | --- | --- |
| 目标地址 | `domains` | 域名，含子域名 |
| | `domainKeywords` | 域名里包含这些文字 |
| | `ipCidrs` | 目标 IP 段，如 `10.0.0.0/8` |
| | `ruleSets` | 设备 sing-box 配置里已经定义的规则集 tag |
| 协议或端口 | `protocols` | 按嗅探到的协议，取值见下 |
| | `ports` | 目标端口 |
| 进程 | `processNames` | 发起连接的进程名，只能识别设备本机发起的连接 |

`protocols` 的取值：`http`、`tls`（HTTPS 等）、`quic`（HTTP/3 等）、`ssh`、`rdp`（远程桌面）、`bittorrent`。

例如：

- 「数据库隧道」设置了 `domains: ["pg-tokyo.example.net"]` 和 `ports: [5432]`，接管的是连 pg-tokyo.example.net、并且目标端口是 5432 的连接。
- 「SSH 出口」设置了 `protocols: ["ssh"]` 和 `ports: [22, 2222]`，接管的是嗅探出 SSH 协议，或者目标端口是 22、2222 的连接。

一条连接符合多个分组时，交给条件更具体的那个，顺序见[本机的 sing-box 配置](#本机的-sing-box-配置)。

### 候选节点

`candidates` 有两种写法。逐个挑选节点，数组的顺序就是优先级：

```json
{ "mode": "list", "nodeIds": ["jp-01", "jp-02", "kr-01"] }
```

按条件自动加入：

```json
{ "mode": "filter", "filter": { "regions": ["香港", "台北", "新加坡"], "protocols": [], "include": [], "exclude": [] } }
```

| 字段 | 说明 |
| --- | --- |
| `regions` | 节点的 `region` 是其中之一 |
| `protocols` | 节点的 `protocol` 是其中之一 |
| `include` | 节点的 `tag` 包含其中任意一个，不区分大小写 |
| `exclude` | 节点的 `tag` 包含其中任意一个就排除，不区分大小写 |

每一项为空表示不限，设置了的几项要同时满足。

- 符合条件的节点按 `GET /nodes` 返回的顺序排列，这个顺序就是优先级。
- 订阅里新增的节点只要符合条件，就自动加入分组，不用修改分组。
- 两种写法都包含停用的节点，但停用的节点不会被选用，也不探测。
- 节点不再是候选节点时（从列表里移除了，或者不再符合条件），这个分组里固定或选中它的状态会被清掉。

### 分组的校验规则

校验规则（第一列就是出错时的 `field`）：

| 字段 | 规则 |
| --- | --- |
| `name` | 必填 |
| `selectorTag` | 只能包含字母、数字、`-` 和 `_`；不能和别的分组重复；不能和节点的 tag 或 `direct` 重名 |
| `deviceIds` | 至少一台 |
| `match` | 至少设置一类条件 |
| `domains` | 有效的域名。保存前转成小写，去掉开头的 `*.` 或 `.` |
| `ipCidrs` | IPv4 或 IPv6 的 IP 段。只填一个 IP 时，保存为 `/32` 或 `/128` |
| `ruleSets` | 只能包含字母、数字、`.`、`-` 和 `_` |
| `ports` | 1–65535 的整数 |
| `candidates` | 逐个挑选时至少一个节点；按条件自动加入时，现在至少要匹配到一个节点 |
| `targetIds` | 按规则自动切换时至少一条 |
| `failThreshold` | 1–10 |
| `recoverThreshold` | 1–10 |
| `probeIntervalSec` | 5–600 |
| `toleranceMs` | 0–1000 |

- 最后五项只在按规则自动切换时检查。
- 列表去掉空白和重复项，id 列表还要去掉不存在的 id。`domainKeywords` 转成小写，`ports` 从小到大排列。
- 新建、修改、删除都记一条 `group-changed` 事件（没有实际改动时不记）。修改时 `message` 列出改了哪些设置，例如“修改了分组「GitHub」：分组规则、规则判定方式”。
- 改了 `selection` 时：
  - 改成手动选择：当前出口是启用的候选节点时，记成选中的节点，流量不动；正在阻断或直连时改走第一个启用的候选节点。
  - 改回按规则自动切换：清掉选中的节点，立即开始探测。首轮结果出来之前出口保持不变。
- 管理服务把新的分组下发给相关设备的 Agent，Agent 更新本机的 sing-box 配置。

## 运行状态

`GET /runtime` 返回每台设备上每个分组的实时状态，可以用 `deviceId` 只看一台设备。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | |
| `groupId` | string | |
| `activeNodeId` | string \| null | selector 当前选中的节点。`"direct"` 表示直连，`null` 表示已阻断 |
| `pinnedNodeId` | string \| null | 自动分组里手动固定的节点；手动分组里选中的节点，没有选过时为 `null` |
| `state` | string | 见下表 |
| `eligibleNodeIds` | string[] | 自动分组里是当前可用的节点，按优先级排列；手动分组里是全部启用的候选节点 |
| `nodes` | `NodeHealth[]` | 自动分组里每个候选节点的健康状态，按候选节点的顺序；手动分组不探测，为空 |
| `lastRoundAt` | string \| null | 最近一轮探测的时间；手动分组为 `null` |
| `lastSwitch` | object \| null | 最近一次出口变化：`at`、`from`、`to`、`reason`。`from` 和 `to` 的取值同 `activeNodeId` |

`state` 按下表从上到下取第一个符合的。手动选择的分组只会是 `stale`、`manual` 或 `blocked`。

| 值 | 界面上显示 | 条件 |
| --- | --- | --- |
| `stale` | 设备离线 | 设备离线，其余字段是离线前的状态 |
| `manual` | 手动选择 | 手动选择的分组，有启用的候选节点 |
| `pinned` | 已手动固定 | 已固定，固定的节点没有被判为不可用 |
| `pinned-down` | 固定的节点不可用 | 已固定，固定的节点不可用 |
| `blocked` | 已阻断 | 全部不可用，`onAllFail` 为 `block`；一个启用的候选节点都没有（`onAllFail` 是什么都一样，因为没有东西可以停、可以直连）；手动选择的分组没有启用的候选节点 |
| `direct` | 已改走直连 | 全部不可用，`onAllFail` 为 `direct` |
| `failing` | 没有可用节点 | 全部不可用，`onAllFail` 为 `keep-last` |
| `unknown` | 等待首轮探测 | 没有可用节点，但有候选节点还没被判过不可用——健康表里是 `unknown`，或者 Agent 还没探测过它 |
| `degraded` | 没有备用节点 | 只有 1 个节点可用 |
| `ok` | 正常 | 至少 2 个节点可用 |

`NodeHealth`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `nodeId` | string | |
| `state` | `up` \| `down` \| `unknown` | 可用、不可用、待探测 |
| `consecutiveFails` | number | 连续未通过的轮数，通过一轮就清零 |
| `consecutiveSuccesses` | number | 连续通过的轮数，失败一轮就清零 |
| `latencyMs` | number \| null | 最近 5 次通过时延迟的中位数 |
| `lastRoundOk` | boolean \| null | 最近一轮是否通过 |
| `failingTargetIds` | string[] | 最近一轮没通过的分组规则，也就是探测目标的 id |
| `changedAt` | string \| null | `state` 最近一次变化的时间 |
| `history` | object[] | 最近 40 轮的判定，从旧到新，每项有 `at`、`ok`、`latencyMs` |

一轮的延迟：`targetMode` 为 `all` 时取各条规则延迟的平均值，为 `any` 时取通过的规则里最小的。前端用两个计数和分组的阈值显示“失败 2/3”“恢复 1/2”这样的进度。

## 探测结果

`GET /probes` 返回每台设备经由每个节点探测每个目标的结果，可以用 `deviceId` 和 `nodeId` 筛选。只有按规则自动切换的分组要求探测的组合才有结果，前端把其余组合显示为“—”（不探测）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | |
| `nodeId` | string | |
| `targetId` | string | |
| `last` | object \| null | 最近一次探测，字段同 `history` 的每一项，另外按目标的类型有 `banner`、`hostKey` 或 `status` |
| `history` | object[] | 最近 40 次探测，从旧到新 |

每次探测：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `at` | string | |
| `ok` | boolean | 是否满足目标的要求 |
| `latencyMs` | number \| null | 成功时是完成探测的耗时，失败时是出错前的耗时 |
| `stage` | string \| null | 实际完成到哪一步，见下表。`null` 表示 TCP 都没连上 |
| `error` | string，可选 | 失败原因，见下表 |
| `banner` | string，可选 | 只在 `last` 里有：SSH 探测收到的标识，如 `SSH-2.0-OpenSSH_9.6` |
| `hostKey` | string，可选 | 只在 `last` 里有：SSH 握手拿到的主机密钥指纹 |
| `status` | number，可选 | 只在 `last` 里有：HTTP 探测收到的状态码 |

| `stage` | 用于 | 界面上显示 |
| --- | --- | --- |
| `tcp` | 三种探测 | TCP 已连通 |
| `banner` | SSH 探测 | 已收到 SSH 标识 |
| `handshake` | SSH 探测 | SSH 握手已完成 |
| `tls` | HTTP 探测，只有 https 网址 | TLS 握手已完成 |
| `response` | HTTP 探测 | 已收到 HTTP 响应 |

SSH 探测依次是 `tcp`、`banner`、`handshake`，做到目标的 `level` 为止；HTTP 探测依次是 `tcp`、`tls`、`response`；TCP 探测只有 `tcp`。

| `error` | 界面上显示 | 说明 |
| --- | --- | --- |
| `timeout` | 超时 | |
| `refused` | 连接被拒绝 | |
| `reset` | 连接被重置 | |
| `proxy` | 连不上节点 | |
| `dns` | 域名解析失败 | |
| `banner` | 没收到 SSH 标识 | SSH 探测：连上了，但对方不是 SSH 服务 |
| `hostkey` | 主机密钥不匹配 | SSH 探测 |
| `tls` | TLS 握手失败 | HTTP 探测，包括证书无效 |
| `status` | 状态码不符 | HTTP 探测。前端直接写出收到的状态码，如“返回 403” |
| `keyword` | 响应里没有关键字 | HTTP 探测 |

## 事件

`GET /events`

| 参数 | 说明 |
| --- | --- |
| `deviceId` | 只看这台设备 |
| `groupId` | 只看这个分组 |
| `kinds` | 事件类型，逗号分隔，如 `switch,all-down` |
| `severities` | 级别，逗号分隔，如 `warn,crit` |
| `since` | 只返回不早于这个时间的事件 |
| `cursor` | 上一页返回的 `nextCursor` |
| `limit` | 每页条数，默认 50，最多 200 |

返回 `{ "items": AppEvent[], "nextCursor": string | null }`。`items` 从新到旧；没有更多时 `nextCursor` 为 `null`。前端不解析 cursor 的内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `at` | string | |
| `kind` | string | 见下表 |
| `severity` | `info` \| `good` \| `warn` \| `crit` | 信息、恢复、警告、严重 |
| `deviceId` | string \| null | 相关的设备 |
| `groupId` | string \| null | 相关的分组 |
| `nodeId` | string \| null | 相关的节点 |
| `from`、`to` | string \| null，可选 | 只有改变出口的事件才有，取值同 `activeNodeId`。前端显示为“从哪里到哪里” |
| `message` | string | 一句话说明发生了什么、为什么，原样显示给用户 |

`message` 要写清楚原因，节点用 tag 称呼，没通过的规则写成“规则名：原因”，例如：

- “HK-01 连续 3 轮未通过探测（GitHub SSH：超时），切换到 HK-02”
- “JP-01 连续 2 轮未通过探测（OpenAI 接口：返回 403），切换到 SG-01（延迟最低，814 ms）”
- “HK-02 连续 3 轮未通过探测（GitHub SSH：超时），候选节点全部不可用，已阻断这个分组的新连接（不会走直连）”
- “JP-01 近 5 轮延迟中位数 541 ms，比 HK-01（795 ms）低 254 ms，超过容差 80 ms”
- “HK-01 已停用，切换到 TW-01”（手动选择的分组）

| `kind` | 界面上显示 | 什么时候记 | 级别 |
| --- | --- | --- | --- |
| `switch` | 切换节点 | 出口换了节点：自动切换；手动分组里选了别的节点，或者选中的节点停用、不再是候选 | 当前节点不可用时 `warn`；其他情况（切回、按延迟切换、手动选择、当前节点被停用或不再是候选）`info` |
| `node-down` | 节点不可用 | 节点连续未通过的轮数达到 `failThreshold` | 一般是 `warn`；从未可用过的节点是 `info`；固定的节点是 `crit` |
| `node-up` | 节点恢复 | 不可用的节点连续通过的轮数达到 `recoverThreshold` | `good` |
| `all-down` | 全部不可用 | 候选节点全部不可用，按 `onAllFail` 处理；手动分组没有启用的候选节点。全部不可用期间出口又变了（比如改了 `onAllFail`），再记一条 | `crit` |
| `recovered` | 出口恢复 | 从全部不可用中恢复，包括手动分组重新有了启用的候选节点 | `good` |
| `pin` | 手动固定 | 自动分组里固定节点 | `info`，固定到不可用的节点时是 `warn` |
| `unpin` | 取消固定 | 手动取消，或者固定的节点被停用 | `info` |
| `device-offline` | 设备离线 | | `warn` |
| `device-online` | 设备上线 | | `good` |
| `group-changed` | 分组变更 | 新建、修改、删除分组 | `info` |
| `node-changed` | 节点变更 | 启用、停用节点 | `info` |

带 `from` 和 `to` 的是 `switch`、`all-down`、`recovered`、`pin`。切换事件的 `message` 已经说明了旧节点为什么不可用时，不再为它单独记 `node-down`；同样，`recovered` 已经提到的恢复不再单独记 `node-up`。

## 实时推送

`GET /stream` 返回 `text/event-stream`。每条消息的 `data` 是一个 JSON，使用默认的消息类型，不要加 `event:` 行：

```text
data: {"type":"update","scopes":["runtimes","probes","events"]}

data: {"type":"reset"}

```

- `update`：`scopes` 列出哪些数据变了，前端重新请求对应的接口。
- `reset`：所有数据都变了，比如从备份恢复之后。前端清空缓存，重新加载。

| scope | 对应的接口 |
| --- | --- |
| `devices` | `/devices`、`/devices/{id}` |
| `nodes` | `/nodes` |
| `targets` | `/targets` |
| `groups` | `/groups`。编辑页用的 `/groups/{id}` 不随推送刷新，免得覆盖正在修改的内容 |
| `runtimes` | `/runtime` |
| `probes` | `/probes` |
| `events` | `/events` |

前端自己做的修改会自己刷新相关数据，推送主要用来反映 Agent 的上报和其他浏览器窗口里的修改。建议：

- 把 1 秒内的变化合成一条消息。每轮探测后通常是 `runtimes`、`probes` 和 `devices`（`lastSeenAt` 变了）。
- 每 15 到 30 秒发一行注释（`: ping`），免得中间的代理断开空闲连接。反向代理要关掉响应缓冲，例如 nginx 的 `proxy_buffering off;`，或者响应头 `X-Accel-Buffering: no`。

断线后重新连上时，前端把全部数据刷新一次，补上断开期间错过的变化。遇到下面几种情况，前端关闭推送，改为每 10 秒刷新全部数据，直到页面重新加载：

- 浏览器不支持 EventSource。
- `/stream` 返回错误状态码，或者响应不是 `text/event-stream`。这种情况浏览器不会自动重连。
- 连续 3 次连接出错，中间没有成功连上过。

## Agent 的行为

前端不直接和 Agent 通信，但界面上的状态和说明文字依赖下面这些行为。模拟引擎里的 `round`、`decide` 和 `decideManual` 实现了同样的规则。

### 本机的 sing-box 配置

设备页展示的配置片段（由 [`src/lib/singbox.ts`](../src/lib/singbox.ts) 生成）就是 Agent 要合并进 sing-box 配置的内容：

- 每个分组一个 selector 出站，tag 为 `selectorTag`，按候选节点的顺序包含启用的节点。按规则自动切换、`onAllFail` 为 `direct` 的分组再加上 `direct`。`interrupt_exist_connections` 对应 `interruptExisting`。分组没有启用的候选节点、又没有选 `direct` 时不生成 selector（sing-box 不接受空的 selector），它接管的流量直接拒绝，不会走直连。
- 路由规则按 `match` 把流量交给 selector。目标地址这一类的字段（`domain_suffix`、`domain_keyword`、`ip_cidr`、`rule_set`）在 sing-box 的同一条规则里本来就是“或”的关系。协议和端口是两类字段，写进同一条规则就要同时满足，所以按协议、按端口各写一条。`process_name` 加到每一条里。一个分组因此生成一到两条规则。
- 分组之间按条件的具体程度排列：设置的条件类别多的在前；一样多时，有目标地址条件的在前；再按分组列表的顺序。比如演示数据里，「数据库隧道」（目标地址和端口）最先，然后是「GitHub」「AI 服务」「流媒体」（目标地址），最后是「SSH 出口」（协议或端口）。所以连 github.com 的 SSH 流量交给「GitHub」。
- 有分组按协议、域名、域名关键字或规则集识别流量时，交给 selector 的规则前面先加一条 `sniff` 规则，sing-box 才能从 TLS 的 SNI、HTTP 的 Host 等拿到域名和协议。
- 设备上有按规则自动切换的分组时，还有一个 socks 入站 `singweb-probe`，监听 `probeInbound`。这些分组启用的候选节点，每个对应一个用户 `probe-{节点 tag}`，路由规则把这个用户的连接送到对应的节点，其他连接一律拒绝，这几条规则排在最前面。Agent 用哪个用户名连接，就是经由哪个节点探测。
- 按规则自动切换、`onAllFail` 为 `block` 的分组还有一个本地规则集 `singweb-block-{selectorTag}`，文件是 `{dataDir}/block-{selectorTag}.json`。没有生成 selector 的分组已经直接拒绝，不需要它。引用它的 `reject` 规则用 `logical` 的 `and` 把这个规则集和分组的条件组合起来，排在这个分组交给 selector 的规则前面。不把规则集直接写进同一条规则，是因为分组自己也可能引用规则集，同一条规则里的多个规则集是“或”的关系，会连带阻断不相干的流量。平时规则集是空的，这些规则不匹配任何连接。
- `ruleSets` 引用的规则集要先在设备的 sing-box 配置里定义好，否则合并后的配置会加载失败。设备页会提示这一点。
- `clash_api` 监听 `clashApi`。

socks 用户的密码和 Clash API 的 secret 由 Agent 在本机生成，不经过管理服务。配置用到了 `sniff`、`route`、`reject` 规则动作，需要 sing-box 1.11 或更新的版本。

### 订阅

- Agent 从 `GET /agent/bootstrap` 和 `GET /agent/sources` 拿订阅列表，返回的每一项是 `{ id, name, url, force }`。
  链接只在管理和设备之间传递，设备不必知道它属于谁。
- `force` 为真时立刻取一次：用户在网页上点了「立即刷新」（`refresh_requested_at` 有值），
  或者这个订阅从没拉过（`last_fetched_at` 为空）。为假时 Agent 自己按 6 小时的节奏判断。
- 取订阅用的是 Node 直接发的请求，不走本机代理——订阅站通常国内可直连。
  User-Agent 伪装成 `v2rayN/6.31`：多数订阅站按 UA 分流，不认识的 UA 直接 403，
  而 Clash、sing-box 这些客户端的 UA 换回来的是 YAML 或 JSON，只有链接列表这一种格式 Agent 会解析。
- 内容以 `{` 或 `[` 开头时按 JSON 解析（Clash / sing-box 的 proxies），否则按订阅链接列表解析。
- 结果用 `POST /agent/sources/{id}/result` 回报，节点一起交上去。
  拉取失败时不带节点上报，服务端因此不会清空这个订阅已经导入的节点——订阅站临时挂了不代表节点没了。

### 探测

- 只有按规则自动切换的分组探测。每 `probeIntervalSec` 秒一轮，每轮对每个启用的候选节点、每条分组规则各探测一次。多个分组在同一时刻探测同一个组合时，只探测一次，结果共用。
- 探测连接经过 `singweb-probe` 入站，以用户 `probe-{节点 tag}` 发出。目标是域名时，把域名原样交给节点（SOCKS5 的域名地址），由节点那边解析。
- `timeoutMs` 从开始连接算起，覆盖整次探测。
- SSH 探测做到目标的 `level` 为止，不进入 SSH 认证阶段。
- HTTP 探测：
  - 发一个 `GET` 请求，不跟随重定向，3xx 响应按它自己的状态码判定。
  - 不带 Cookie，也不带任何账号或凭据。
  - https 网址要校验证书，SNI 用网址里的主机名。证书无效算 `tls` 失败。
  - 状态码符合后再检查关键字：区分大小写，只在响应内容的前 64 KB 里找。
- TCP 探测连上目标端口就算通过，随即关闭连接。很多代理协议在节点真正连上目标之前就回复连接成功，所以 TCP 探测主要反映节点本身能不能用。
- 一个节点这一轮算不算通过，看 `targetMode`：`all` 要求所有规则都通过，`any` 只要任一规则通过。

### 判定

- 可用变为不可用：连续 `failThreshold` 轮未通过。
- 不可用变为可用：连续 `recoverThreshold` 轮通过。
- 刚开始探测的节点：第一轮通过就算可用；连续 `failThreshold` 轮未通过算不可用。
- 延迟取最近 5 次通过时的中位数，节点变为不可用时清空。按延迟选择时，样本少于 3 个的节点不参与比较。

### 选择和切换

按规则自动切换的分组没有固定节点时，每轮判定之后：

1. 当前节点可用，就不切换。只有两种例外：
   - `priority` 且打开了 `failback`，优先级更高的节点恢复可用：切回去。
   - `latency`，另一个节点的延迟中位数比当前节点低，差值超过 `toleranceMs`：切过去。
2. 当前节点不可用、被停用或者不再是候选节点：`priority` 选可用节点里优先级最高的；`latency` 选延迟中位数最低的，样本都不够时选优先级最高的。
3. 当前节点还在首轮探测中：等结果出来再决定。

切换通过 Clash API 完成：

```http
PUT http://{clashApi}/proxies/{selectorTag}
Authorization: Bearer {secret}
Content-Type: application/json

{"name": "HK-02"}
```

切换只影响新连接。`interruptExisting` 打开时，sing-box 断开经过旧节点的连接，正在使用的长连接（比如 SSH 会话、WebSocket）会掉线，重连后走新节点。关闭时，已经打开的连接继续走旧节点，要断开重连才会走新节点。前端在切换后 15 分钟内会提醒这一点。

### 手动选择

`selection` 为 `manual` 的分组，Agent 不探测，也不自动切换：

- 出口是用户选中的节点。没有选过，或者选中的节点停用了、不再是候选节点时，走第一个启用的候选节点。
- 没有选过节点时，出口跟着第一个启用的候选节点变：排在前面的节点重新启用了，或者候选节点的顺序变了，出口也跟着换，记一条 `switch` 事件，例如“没有选过节点，改走第一个启用的候选节点 HK-01”。
- 没有启用的候选节点时，设备上没有这个 selector，这个分组接管的新连接被拒绝，上报 `blocked`，记 `all-down`；重新有了启用的节点时记 `recovered`。
- 不会改走直连：手动选择的分组不用 `onAllFail`，selector 里也没有 `direct`。
- 切换同样通过 Clash API 完成，`interruptExisting` 同样生效。

### 全部不可用

按规则自动切换的分组里，启用的候选节点全部被判为不可用，或者没有启用的候选节点时，Agent 按 `onAllFail` 处理，并记一条 `all-down` 事件。还有节点在等首轮探测的结果时，先等结果出来，不算全部不可用。

| `onAllFail` | 界面上显示 | Agent 的动作 | 上报的状态 |
| --- | --- | --- | --- |
| `block` | 阻断并告警 | 把阻断规则集改成匹配所有 TCP 和 UDP 连接：`{"version": 3, "rules": [{"network": ["tcp", "udp"]}]}`。sing-box 会自动重新加载修改过的本地规则集，这个分组接管的新连接立刻被拒绝，QUIC 这类走 UDP 的连接也一样 | `blocked`，`activeNodeId` 为 `null` |
| `keep-last` | 保持当前节点并告警 | selector 保持不动 | `failing` |
| `direct` | 改走直连并告警 | 把 selector 切到 `direct` | `direct` |

只有明确选了 `direct`，流量才会走直连。

`keep-last` 保持的是当前节点。当前节点已停用或不再是候选节点时，改用优先级最高的候选节点；没有启用的候选节点时，设备上没有 selector，只能阻断，上报 `blocked`。

全部不可用期间，下面的变化立即生效，并再记一条 `all-down` 事件：

- 修改了 `onAllFail`。
- `keep-last` 保持的节点被停用，或者被移出候选节点。

有节点重新可用后，Agent 把阻断规则集改回 `{"version": 3, "rules": []}`，切到最合适的节点，记一条 `recovered` 事件。

### 固定

固定只用在按规则自动切换的分组里。固定期间 Agent 照常探测和判定，但不自动切换，全部不可用时也不按 `onAllFail` 处理：固定是用户明确的选择，优先于自动规则。固定的节点变为不可用时只记 `node-down`（级别 `crit`），状态上报为 `pinned-down`。

已阻断时固定节点会解除阻断：Agent 先把阻断规则集改回空的，再把 selector 切到固定的节点。取消固定后立即按当前的探测结果重新选择，候选节点仍然全部不可用时按 `onAllFail` 处理。

固定的节点和手动分组选中的节点都保存在管理服务，下发给 Agent，Agent 在本地也保存一份。

### 离线

- Agent 和管理服务断开后，继续按最后收到的分组、固定的节点和手动分组选中的节点，在本地探测、切换、阻断，事件和探测结果先存在本地。
- 重新连上后，Agent 补传离线期间的事件和探测记录，管理服务把设备标记为在线。
