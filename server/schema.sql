-- singweb 管理服务的库结构。
-- 服务端本身不保存任何状态，重启后一切从这里读出来。

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- 账号

create table if not exists users (
  id            text primary key,
  username      text not null unique,
  -- scrypt：算法参数$盐$散列，见 server/src/auth.ts
  password_hash text not null,
  role          text not null default 'admin' check (role in ('admin', 'viewer')),
  created_at    timestamptz not null default now()
);

-- 登录会话。浏览器只拿到一个随机 token，这里存的是它的散列，
-- 所以库被读走也不能直接拿来登录，服务端多实例部署时也不需要共享内存。
create table if not exists sessions (
  token_hash text primary key,
  user_id    text not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

-- ---------------------------------------------------------------- 设备

create table if not exists devices (
  id              text primary key,
  name            text not null,
  hostname        text not null,
  platform        text not null check (platform in ('macos', 'linux')),
  os_version      text not null default '',
  agent_version   text not null default '',
  singbox_version text not null default '',
  -- Agent 每次上报都会更新；超过 90 秒没上报就当作离线
  last_seen_at    timestamptz not null default now(),
  clash_api       text not null default '127.0.0.1:9090',
  probe_inbound   text not null default '127.0.0.1:2080',
  data_dir        text not null default '/etc/singweb',
  note            text,
  -- Agent 生成 Clash API 密钥时用的种子，不发给前端
  secret          text not null default '',
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- 订阅

create table if not exists node_sources (
  id              text primary key,
  name            text not null,
  -- 完整订阅链接，含 token。只在这个库里，不进仓库、不进日志、不下发给前端
  url             text not null,
  enabled         boolean not null default true,
  last_fetched_at timestamptz,
  last_error      text,
  node_count      integer not null default 0,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- 节点

create table if not exists nodes (
  id         text primary key,
  tag        text not null,
  protocol   text not null,
  server     text not null,
  port       integer not null,
  region     text not null default '',
  enabled    boolean not null default true,
  source     text not null default '手动添加',
  -- 原样的 sing-box 出站内容，Agent 生成配置时直接用它
  outbound   jsonb not null,
  source_id  text references node_sources (id) on delete set null,
  -- 同一个订阅里的同一个节点重复出现时用它合并
  identity   text not null default '',
  updated_at timestamptz not null default now()
);

-- 一个订阅里同一个节点只留一条
create unique index if not exists nodes_source_identity_idx
  on nodes (source_id, identity) where source_id is not null;

create index if not exists nodes_updated_at_idx on nodes (updated_at desc);

-- ---------------------------------------------------------------- 探测目标

create table if not exists targets (
  id         text primary key,
  name       text not null,
  kind       text not null check (kind in ('ssh', 'http', 'tcp')),
  timeout_ms integer not null default 5000,
  note       text,
  -- 三种目标各自的字段：host/port/level/host_key 或 url/expect_status/keyword
  spec       jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 分组

create table if not exists groups (
  id                   text primary key,
  name                 text not null,
  selector_tag         text not null unique,
  device_ids           jsonb not null default '[]'::jsonb,
  match                jsonb not null,
  candidates           jsonb not null,
  selection            text not null default 'auto' check (selection in ('auto', 'manual')),
  -- 分组规则：每条引用一个探测目标
  target_ids           jsonb not null default '[]'::jsonb,
  target_mode          text not null default 'all' check (target_mode in ('all', 'any')),
  strategy             text not null default 'priority' check (strategy in ('priority', 'latency')),
  fail_threshold       integer not null default 3,
  recover_threshold    integer not null default 2,
  probe_interval_sec   integer not null default 60,
  tolerance_ms         integer not null default 50,
  failback             boolean not null default true,
  interrupt_existing   boolean not null default false,
  on_all_fail          text not null default 'block' check (on_all_fail in ('block', 'keep-last', 'direct')),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------- 运行时状态

-- 每个设备的每个分组当前选中的节点。Agent 切换后写这里，界面读这里。
create table if not exists group_runtime (
  device_id        text not null references devices (id) on delete cascade,
  group_id         text not null references groups (id) on delete cascade,
  active_node_id   text,
  pinned_node_id   text,
  -- 各候选节点的健康状态，键是节点 id
  nodes            jsonb not null default '[]'::jsonb,
  last_round_at    timestamptz,
  last_switch      jsonb,
  reported_at      timestamptz not null default now(),
  primary key (device_id, group_id)
);

-- 探测结果：设备 → 节点 → 目标
create table if not exists probes (
  device_id  text not null,
  node_id    text not null,
  target_id  text not null,
  last       jsonb,
  -- 从旧到新，最多 40 条
  history    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (device_id, node_id, target_id)
);

create index if not exists probes_device_idx on probes (device_id);

-- ---------------------------------------------------------------- 事件

create table if not exists events (
  id        text primary key,
  at        timestamptz not null default now(),
  kind      text not null,
  severity  text not null check (severity in ('info', 'good', 'warn', 'crit')),
  device_id text,
  group_id  text,
  node_id   text,
  from_id   text,
  to_id     text,
  message   text not null
);

create index if not exists events_at_idx on events (at desc);
create index if not exists events_device_idx on events (device_id, at desc);
create index if not exists events_group_idx on events (group_id, at desc);

-- Agent 离线时排队的切换操作，重连后按顺序重放
create table if not exists pending_switches (
  id         text primary key,
  device_id  text not null references devices (id) on delete cascade,
  group_id   text not null,
  node_id    text,
  reason     text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists pending_switches_device_idx on pending_switches (device_id, created_at);

-- ---------------------------------------------------------------- 增量补列
--
-- 下面的列是后来加的，用 alter ... if not exists 追加，已存在的库重启时自动补上，
-- 不必手工迁移，也不必重建表。

-- 设备上那个 selector 实际列在 outbounds 里的节点，由 Agent 通过 Clash API 读出来上报。
-- 网页上的候选列表来自数据库，设备上的来自 sing-box 配置文件，两边可能不一致
-- （比如粘贴的片段是旧的、或者手动删过节点），这个字段就是让网页知道真实情况的。
-- null 表示 Agent 没读到（Clash API 不通或 selector 不存在），跟空数组是两回事：
-- 空数组是"设备上确实一个都没有"，null 是"不知道"，后者不该拿来拦用户。
alter table group_runtime
  add column if not exists available_node_ids jsonb;

-- 待办执行失败时的重试记录。没有上限的话，一个永远不会成功的待办
-- 会每 15 秒重试一次，直到天荒地老，而且失败得悄无声息。
alter table pending_switches
  add column if not exists attempts integer not null default 0;
alter table pending_switches
  add column if not exists last_error text;
-- 有值表示已经放弃重试。列表接口不再把它下发给 Agent，网页上显示为失败
alter table pending_switches
  add column if not exists failed_at timestamptz;

-- 网页上点了"立即刷新"时打上的时间戳，Agent 下一轮 bootstrap 领走。
-- 服务端自己不联网拉订阅：订阅链接只该下发给设备，由设备去取。
alter table node_sources
  add column if not exists refresh_requested_at timestamptz;
