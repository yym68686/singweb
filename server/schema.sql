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
  platform        text not null check (platform in ('macos', 'linux', 'windows')),
  os_version      text not null default '',
  agent_version   text not null default '',
  singbox_version text not null default '',
  -- Agent 每次上报都会更新；超过 90 秒没上报就当作离线
  last_seen_at    timestamptz not null default now(),
  clash_api       text not null default '127.0.0.1:9090',
  probe_inbound   text not null default '127.0.0.1:2080',
  data_dir        text not null default '/etc/singweb',
  note            text,
  -- 设备密钥：注册时发给 Agent，之后每次请求都用它认证。不发给前端
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

-- 早期版本里"立即刷新"要等设备来领，用这一列做标记。现在订阅由服务端自己拉，
-- 这一列不再读写，留着只是为了不动已有的库。
alter table node_sources
  add column if not exists refresh_requested_at timestamptz;

-- 平台多了 Windows。建表语句里的检查只对新库生效，已有的库要把旧约束换掉
alter table devices drop constraint if exists devices_platform_check;
alter table devices
  add constraint devices_platform_check check (platform in ('macos', 'linux', 'windows'));

-- 设备上本机代理的监听地址（Agent 管理的 sing-box 的 mixed 入站），设备页照着它写使用说明
alter table devices
  add column if not exists proxy_listen text not null default '';

-- 本机 sing-box 起不来时的原因（端口被占、配置检查没过、找不到程序），设备页照着它提示怎么修。
-- 空表示正常
alter table devices
  add column if not exists singbox_error text;

-- 这台设备的离线已经记过事件、推过网页了。在线与否是按 last_seen_at 现算的，
-- 没有这一列的话，服务端每扫一遍都会把同一次离线再记一遍；设备再上报时清掉
alter table devices
  add column if not exists offline_noted boolean not null default false;

-- ---------------------------------------------------------------- 设置

-- 服务端自己的少量键值：singweb 订阅链接的 token、一次性初始化的标记
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- 设备接入

-- 设备页「接入新设备」生成的一次性令牌。跟登录会话分开：令牌会出现在命令行里，
-- 被别人看到也只能接入一台设备，而且用过一次、或者过了期限就作废。库里只存散列。
create table if not exists enroll_tokens (
  id         text primary key,
  token_hash text not null unique,
  created_by text references users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  -- 用这个令牌接入的设备，网页靠它知道"刚才那条命令跑起来了"
  device_id  text
);

-- 生成令牌时网页所在的站点，安装脚本照着它连回管理服务。光看请求本身推不准：
-- 有的平台在边缘终止 TLS，转进来的请求一律是 http，脚本里就会写成 http，
-- Agent 跟着重定向去 https 时 Authorization 头会被丢掉。空表示没记，按请求本身推算
alter table enroll_tokens
  add column if not exists base text;

-- ---------------------------------------------------------------- 清理

-- 早期版本的 Agent 会把本机 sing-box 配置里的节点报上来，记成「本机配置」。
-- 现在设备只用 singweb 下发的节点，这些影子节点没有来源，也不会再更新
delete from nodes where source_id is null and source = '本机配置';
delete from probes p where not exists (select 1 from nodes n where n.id = p.node_id);

-- 早期版本每次上报都往探测历史里追加一条，同一次探测会重复好几回。
-- 按探测时间去重，留下的仍然是从旧到新
update probes p
   set history = dedup.history
  from (
    select device_id, node_id, target_id,
           coalesce(jsonb_agg(item order by first_idx), '[]'::jsonb) as history
      from (
        select device_id, node_id, target_id, item, min(idx) as first_idx
          from probes, jsonb_array_elements(history) with ordinality as t(item, idx)
         group by device_id, node_id, target_id, item
      ) as items
     group by device_id, node_id, target_id
  ) as dedup
 where p.device_id = dedup.device_id
   and p.node_id = dedup.node_id
   and p.target_id = dedup.target_id
   and jsonb_array_length(p.history) <> jsonb_array_length(dedup.history);
