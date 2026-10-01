/**
 * 安装 Agent 用的一组接口：两条命令和一个压缩包。
 *
 * 设备页把命令原文显示给用户复制，用户在那台机器上跑一下就好了。
 * 之所以由服务端现发脚本而不是让用户自己去 clone 仓库：
 * 脚本里要带服务端地址和刚生成的一次性令牌，而且 Agent 是 Node 直接跑的
 * TypeScript，没有任何构建步骤——下一份源码就能用。
 *
 * 脚本做的事：
 *   1. 找一个够新的 Node，没有就下一份官方的放进 ~/.singweb/node
 *   2. 找一个够新的 sing-box，没有就下一份官方的放进 ~/.singweb/bin
 *   3. 下载 Agent 源码，用令牌接入
 *   4. 设成登录后自动运行（macOS 用 LaunchAgent，Windows 用「启动」文件夹），马上启动
 * 全程不需要管理员权限，所有东西都在用户自己的目录里。
 *
 * 这些地址不带登录态，但要能被 curl 直接拉：所以都在 /api/v1 下面，
 * 不在静态文件那一片（前面的静态处理器会把不认识的路由当成前端页面兜底）。
 */

import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { MIN_SINGBOX } from '../../../shared/singbox.ts'
import { badRequest, sendJson, type Router } from '../http.ts'
import * as store from '../store.ts'
import { makeTarGz, type TarEntry } from '../tarball.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：server/src/routes 往上三层 */
const ROOT = join(HERE, '../../..')

/**
 * 要打进包里的源码目录。按目录读而不是写一份文件清单：
 * Agent 和 shared 的模块是互相 import 的，漏一个文件装出来就是运行时才报错，
 * 而这份清单没人会记得同步。
 */
const SOURCE_DIRS = ['agent/src', 'shared']
/** 单独要带上的文件：Agent 从自己的 package.json 读版本号 */
const SOURCE_FILES = ['agent/package.json']

/** 包里不要的东西：类型检查的配置和 tsbuildinfo 之类，设备上跑不到 */
const SKIP = /\.(tsbuildinfo|log)$/

/**
 * Node 直接跑 TypeScript 的最低版本：22.18 和 23.6 起不用加任何参数。
 * 安装脚本按这个判断本机的 Node 能不能用，不够就下一份官方的。
 */
const NODE_ENGINES = '^22.18.0 || >=23.6.0'

/** 本机没有 Node 时下载的版本线。24 是长期支持版 */
const NODE_DIST = 'https://nodejs.org/dist/latest-v24.x'

/**
 * 本机没有 sing-box 时下载的版本。固定一个测过的版本，
 * 而不是追 latest：sing-box 的配置格式隔几个版本就会删旧字段。
 */
const SINGBOX_VERSION = '1.13.14'
const SINGBOX_RELEASES = 'https://github.com/SagerNet/sing-box/releases/download'

/** LaunchAgent 的标签，也是 plist 的文件名 */
const LAUNCHD_LABEL = 'com.singweb.agent'

/** 令牌只会是这些字符。挡住别的，免得有人借查询串往脚本里塞命令 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/
/** 服务端地址同理：只认 http(s)://主机[:端口]，主机可以是域名、IPv4 或方括号里的 IPv6 */
const BASE_RE = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/

/** 把源码读进来打成包 */
async function buildAgentTarball(): Promise<Buffer> {
  const entries: TarEntry[] = []
  const paths = [...SOURCE_FILES]
  for (const dir of SOURCE_DIRS) paths.push(...(await listFiles(dir)))
  for (const path of paths) {
    if (SKIP.test(path)) continue
    entries.push({
      path,
      content: await readFile(join(ROOT, path)),
      ...(path.endsWith('bin.ts') ? { mode: 0o755 } : {}),
    })
  }
  // 包根上的 package.json 管的是 shared 目录：让 node 按 ES module 解析它的 import
  entries.push({
    path: 'package.json',
    content: JSON.stringify(
      { name: 'singweb-agent-bundle', private: true, type: 'module', engines: { node: NODE_ENGINES } },
      null,
      2,
    ),
  })
  return makeTarGz(entries)
}

/** 目录下的所有文件，相对仓库根目录的路径。目录只有一层，不需要递归 */
async function listFiles(dir: string): Promise<string[]> {
  const names = await readdir(join(ROOT, dir), { withFileTypes: true })
  return names.filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`).sort()
}

/**
 * 服务端自己的地址。反向代理后面要用 x-forwarded-*，
 * 否则命令里会写成容器内部的 0.0.0.0:8080，用户拿到手跑不通。
 */
function selfBase(req: IncomingMessage): string {
  const proto = header(req, 'x-forwarded-proto')?.split(',')[0]?.trim() || (isTls(req) ? 'https' : 'http')
  const host = header(req, 'x-forwarded-host')?.split(',')[0]?.trim() || header(req, 'host') || 'localhost'
  const base = `${proto}://${host}`
  if (!BASE_RE.test(base)) throw badRequest('请求里的主机名不对，没法生成安装脚本。')
  return base
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function isTls(req: IncomingMessage): boolean {
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}

/** 下发的文本文件统一带上这些头 */
function sendFile(res: Parameters<typeof sendJson>[0], type: string, body: string | Buffer): void {
  if (res.headersSent) return
  res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 令牌不能用时下发的脚本：只打印原因然后失败。
 *
 * 不直接回 4xx：`curl -f … | sh` 遇到 4xx 只会打出一行 curl 的错误码，
 * PowerShell 5 的 irm 也不显示响应正文，用户看不出是命令过期了。
 */
const STALE_TEXT = '这条接入命令已经失效（生成后 30 分钟内有效，只能用一次）。回网页的设备页重新生成一条。'

function staleShell(): string {
  return `#!/bin/sh\necho "${STALE_TEXT}" >&2\nexit 1\n`
}

function stalePowershell(): string {
  return `throw '${STALE_TEXT}'\n`
}

/**
 * macOS 的安装脚本。
 *
 * 整个脚本包在 main 函数里最后才调用：`curl | sh` 是边下边执行的，
 * 网络断在半截时，没包的话会执行半份脚本；包了之后 sh 要读完整个函数才开始跑。
 */
function macosScript(base: string, token: string): string {
  const [minMajor, minMinor] = MIN_SINGBOX.split('.').map(Number)
  return `#!/bin/sh
# singweb Agent 安装脚本（macOS）。这一份是服务端现生成的，别改它，要改改服务端的代码。
#
# 可以用环境变量调整：
#   SINGWEB_HOME=目录        装到别处，默认 ~/.singweb
#   SINGBOX_PATH=路径        指定用哪个 sing-box
#   SINGWEB_NO_SERVICE=1     不设开机自启，在当前终端前台运行
set -eu

main() {
  SERVER="${base}"
  TOKEN="${token}"
  HOME_DIR="\${SINGWEB_HOME:-$HOME/.singweb}"
  export SINGWEB_HOME="$HOME_DIR"
  AGENT_DIR="$HOME_DIR/agent"
  LOG="$HOME_DIR/agent.log"
  PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
  DOMAIN="gui/$(id -u)"

  if [ "$(uname -s)" != "Darwin" ]; then
    fail "这条命令是给 macOS 用的。Windows 回设备页切到 Windows 那一栏。"
  fi

  # Rosetta 下的终端里 uname -m 会说 x86_64，按真实的芯片下载
  ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    ARCH=arm64
  fi
  case "$ARCH" in
    arm64) NODE_ARCH=arm64; SINGBOX_ARCH=arm64 ;;
    x86_64) NODE_ARCH=x64; SINGBOX_ARCH=amd64 ;;
    *) fail "不支持这种处理器：$ARCH" ;;
  esac

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$HOME_DIR"

  # 旧的 Agent 先停下来：下面要替换它的文件，还要用新令牌重新接入
  launchctl bootout "$DOMAIN/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true

  find_node
  find_singbox

  step "下载 Agent"
  rm -rf "$AGENT_DIR.new"
  mkdir -p "$AGENT_DIR.new"
  curl -fsSL "$SERVER/api/v1/install/agent.tar.gz" | tar -xz -C "$AGENT_DIR.new"
  rm -rf "$AGENT_DIR"
  mv "$AGENT_DIR.new" "$AGENT_DIR"
  BIN="$AGENT_DIR/agent/src/bin.ts"

  step "接入 $SERVER"
  SINGWEB_INSTALLER=1 "$NODE" --disable-warning=ExperimentalWarning "$BIN" join \\
    --server "$SERVER" --token "$TOKEN" --singbox "$SINGBOX" </dev/null

  if [ "\${SINGWEB_NO_SERVICE:-}" = "1" ]; then
    step "在前台运行，按 Ctrl-C 退出"
    rm -rf "$TMP"
    exec "$NODE" --disable-warning=ExperimentalWarning "$BIN" run </dev/null
  fi

  step "设为登录后自动运行"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$(xml "$BIN")</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SINGWEB_HOME</key><string>$(xml "$HOME_DIR")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLIST_EOF
  # bootout 是异步的，紧跟着 bootstrap 偶尔会报「正在进行」，多试几次
  tries=0
  until launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 5 ]; then
      launchctl bootstrap "$DOMAIN" "$PLIST"
      break
    fi
    sleep 1
  done

  echo
  echo "装好了。Agent 已经在后台运行，网页的设备页会显示这台电脑的状态。"
  echo "  日志：$LOG"
  echo "  本机状态：\\"$NODE\\" \\"$BIN\\" status"
  echo "  卸载：launchctl bootout $DOMAIN/${LAUNCHD_LABEL}; \\"$NODE\\" \\"$BIN\\" leave; rm -f \\"$PLIST\\""
}

step() {
  echo "==> $1"
}

fail() {
  echo "安装失败：$1" >&2
  exit 1
}

# plist 是 XML，路径里万一有 & 或尖括号要转义
xml() {
  printf '%s' "$1" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g'
}

# 能直接跑 TypeScript 的 Node：22.18+、23.6+ 或 24 以上
node_ok() {
  "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a >= 24 || (a === 23 && b >= 6) || (a === 22 && b >= 18) ? 0 : 1)' >/dev/null 2>&1
}

# 先找本机已有的。开机自启时没有终端里的 PATH，所以要记下绝对路径：
# 固定位置的直接用（Homebrew 升级后这个链接还在）；PATH 里找到的记下真正的可执行文件，
# nvm、fnm、asdf 给的那个路径离开终端就不一定有效了
find_node() {
  NODE=""
  for candidate in "$HOME_DIR/node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ] && node_ok "$candidate"; then
      NODE="$candidate"
      break
    fi
  done
  if [ -z "$NODE" ]; then
    candidate=$(command -v node 2>/dev/null || true)
    if [ -n "$candidate" ] && node_ok "$candidate"; then
      NODE=$("$candidate" -p 'process.execPath')
    fi
  fi
  if [ -n "$NODE" ]; then
    step "使用 Node $("$NODE" -v)：$NODE"
    return
  fi

  step "没找到 22.18 以上的 Node，下载一份放进 $HOME_DIR/node"
  curl -fsSL "${NODE_DIST}/SHASUMS256.txt" -o "$TMP/node.sums"
  line=$(grep -E " node-v[0-9.]+-darwin-$NODE_ARCH\\.tar\\.gz\\$" "$TMP/node.sums" | head -n 1)
  [ -n "$line" ] || fail "nodejs.org 上没找到 macOS $NODE_ARCH 的 Node 安装包。"
  file=\${line##* }
  sum=\${line%% *}
  curl -fL --progress-bar "${NODE_DIST}/$file" -o "$TMP/$file"
  echo "$sum  $TMP/$file" | shasum -a 256 -c - >/dev/null || fail "下载的 Node 校验不通过，重新运行一次试试。"
  rm -rf "$HOME_DIR/node.new"
  mkdir -p "$HOME_DIR/node.new"
  tar -xzf "$TMP/$file" -C "$HOME_DIR/node.new" --strip-components 1
  rm -rf "$HOME_DIR/node"
  mv "$HOME_DIR/node.new" "$HOME_DIR/node"
  NODE="$HOME_DIR/node/bin/node"
}

singbox_ok() {
  version=$("$1" version 2>/dev/null | head -n 1 | awk '{print $3}')
  [ -n "$version" ] || return 1
  major=\${version%%.*}
  rest=\${version#*.}
  minor=\${rest%%.*}
  case "$major$minor" in *[!0-9]*) return 1 ;; esac
  [ "$major" -gt ${minMajor} ] || { [ "$major" -eq ${minMajor} ] && [ "$minor" -ge ${minMinor} ]; }
}

find_singbox() {
  SINGBOX=""
  for candidate in "\${SINGBOX_PATH:-}" "$HOME_DIR/bin/sing-box" /opt/homebrew/bin/sing-box /usr/local/bin/sing-box "$(command -v sing-box 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && singbox_ok "$candidate"; then
      SINGBOX=$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")
      step "使用 sing-box $("$SINGBOX" version | head -n 1 | awk '{print $3}')：$SINGBOX"
      return
    fi
  done

  step "没找到 ${MIN_SINGBOX} 以上的 sing-box，下载 ${SINGBOX_VERSION} 放进 $HOME_DIR/bin"
  name="sing-box-${SINGBOX_VERSION}-darwin-$SINGBOX_ARCH"
  curl -fL --progress-bar "${SINGBOX_RELEASES}/v${SINGBOX_VERSION}/$name.tar.gz" -o "$TMP/sing-box.tar.gz"
  mkdir -p "$TMP/sing-box" "$HOME_DIR/bin"
  tar -xzf "$TMP/sing-box.tar.gz" -C "$TMP/sing-box" --strip-components 1
  mv -f "$TMP/sing-box/sing-box" "$HOME_DIR/bin/sing-box"
  chmod 755 "$HOME_DIR/bin/sing-box"
  SINGBOX="$HOME_DIR/bin/sing-box"
}

main "$@"
`
}

/**
 * Windows 的安装脚本，用 `irm … | iex` 跑。
 *
 * 整个包在 & { } 里：变量不会漏到用户的 PowerShell 会话里，出错用 throw 而不是 exit——
 * iex 里 exit 会把用户的窗口直接关掉。
 *
 * 开机自启用「启动」文件夹里的一个 .vbs：不需要管理员权限，也不会弹黑窗口。
 * 它在 Agent 异常退出后隔 30 秒再拉起来，正常退出（比如 leave）就不管了。
 */
function windowsScript(base: string, token: string): string {
  const [minMajor, minMinor] = MIN_SINGBOX.split('.').map(Number)
  return `# singweb Agent 安装脚本（Windows）。这一份是服务端现生成的，别改它，要改改服务端的代码。
#
# 可以用环境变量调整：
#   $env:SINGWEB_HOME = '目录'      装到别处，默认 %USERPROFILE%\\.singweb
#   $env:SINGBOX_PATH = '路径'      指定用哪个 sing-box.exe
#   $env:SINGWEB_NO_SERVICE = '1'   不设开机自启，在当前窗口前台运行
& {
  $ErrorActionPreference = 'Stop'
  # 进度条会让 Invoke-WebRequest 慢好几倍
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Server = '${base}'
  $Token = '${token}'
  $HomeDir = if ($env:SINGWEB_HOME) { $env:SINGWEB_HOME } else { Join-Path $env:USERPROFILE '.singweb' }
  $AgentDir = Join-Path $HomeDir 'agent'
  $Bin = Join-Path $AgentDir 'agent\\src\\bin.ts'
  $Log = Join-Path $HomeDir 'agent.log'
  $Vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'singweb-agent.vbs'

  function Step($text) { Write-Host "==> $text" }

  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($arch) {
    'AMD64' { $NodeArch = 'x64'; $SingboxArch = 'amd64' }
    'ARM64' { $NodeArch = 'arm64'; $SingboxArch = 'arm64' }
    default { throw "不支持这种处理器：$arch" }
  }

  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ('singweb-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $Tmp, $HomeDir | Out-Null

  try {
    # 旧的 Agent 先停下来：先停守护它的 wscript，不然 node 一退出又被拉起来
    Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" |
      Where-Object { $_.CommandLine -like '*singweb-agent.vbs*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -like "*$Bin*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    # 能直接跑 TypeScript 的 Node：22.18+、23.6+ 或 24 以上
    function Test-Node($path) {
      if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $false }
      try { $text = (& $path --version) 2>$null } catch { return $false }
      if ($text -notmatch '^v(\\d+)\\.(\\d+)\\.') { return $false }
      $a = [int]$Matches[1]; $b = [int]$Matches[2]
      return ($a -ge 24) -or ($a -eq 23 -and $b -ge 6) -or ($a -eq 22 -and $b -ge 18)
    }

    $Node = $null
    $fromPath = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    foreach ($candidate in @((Join-Path $HomeDir 'node\\node.exe'), $fromPath)) {
      if (Test-Node $candidate) { $Node = (& $candidate -p 'process.execPath'); break }
    }
    if ($Node) {
      Step "使用 Node $(& $Node --version)：$Node"
    } else {
      Step "没找到 22.18 以上的 Node，下载一份放进 $HomeDir\\node"
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri '${NODE_DIST}/SHASUMS256.txt').Content -split "\`n"
      $line = $sums | Where-Object { $_ -match " node-v[\\d.]+-win-$NodeArch\\.zip$" } | Select-Object -First 1
      if (-not $line) { throw "nodejs.org 上没找到 Windows $NodeArch 的 Node 安装包。" }
      $sum, $file = $line -split '\\s+', 2
      $zip = Join-Path $Tmp $file
      Invoke-WebRequest -UseBasicParsing -Uri "${NODE_DIST}/$file" -OutFile $zip
      if ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash -ne $sum.ToUpper()) {
        throw '下载的 Node 校验不通过，重新运行一次试试。'
      }
      # 解到同一个目录下再挪：跨盘符的 Move-Item 挪不了目录
      $unpacked = Join-Path $HomeDir 'node.new'
      if (Test-Path -LiteralPath $unpacked) { Remove-Item -Recurse -Force -LiteralPath $unpacked }
      New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
      tar -xf $zip -C $unpacked
      if ($LASTEXITCODE -ne 0) { throw '解压 Node 失败。' }
      $nodeDir = Join-Path $HomeDir 'node'
      if (Test-Path -LiteralPath $nodeDir) { Remove-Item -Recurse -Force -LiteralPath $nodeDir }
      Move-Item -LiteralPath (Get-ChildItem -LiteralPath $unpacked -Directory | Select-Object -First 1).FullName -Destination $nodeDir
      Remove-Item -Recurse -Force -LiteralPath $unpacked
      $Node = Join-Path $nodeDir 'node.exe'
    }

    function Test-Singbox($path) {
      if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $false }
      try { $text = (& $path version | Select-Object -First 1) 2>$null } catch { return $false }
      if ($text -notmatch 'version (\\d+)\\.(\\d+)') { return $false }
      $a = [int]$Matches[1]; $b = [int]$Matches[2]
      return ($a -gt ${minMajor}) -or ($a -eq ${minMajor} -and $b -ge ${minMinor})
    }

    $Singbox = $null
    $sbFromPath = Get-Command sing-box.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
    foreach ($candidate in @($env:SINGBOX_PATH, (Join-Path $HomeDir 'bin\\sing-box.exe'), $sbFromPath)) {
      if (Test-Singbox $candidate) { $Singbox = (Resolve-Path -LiteralPath $candidate).Path; break }
    }
    if ($Singbox) {
      Step "使用 sing-box：$Singbox"
    } else {
      Step "没找到 ${MIN_SINGBOX} 以上的 sing-box，下载 ${SINGBOX_VERSION} 放进 $HomeDir\\bin"
      $name = "sing-box-${SINGBOX_VERSION}-windows-$SingboxArch"
      $zip = Join-Path $Tmp 'sing-box.zip'
      Invoke-WebRequest -UseBasicParsing -Uri "${SINGBOX_RELEASES}/v${SINGBOX_VERSION}/$name.zip" -OutFile $zip
      $unpacked = Join-Path $Tmp 'sing-box'
      New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
      tar -xf $zip -C $unpacked
      if ($LASTEXITCODE -ne 0) { throw '解压 sing-box 失败。' }
      $binDir = Join-Path $HomeDir 'bin'
      New-Item -ItemType Directory -Force -Path $binDir | Out-Null
      # 有的版本带着 dll，整个目录的文件一起拷过去
      Get-ChildItem -LiteralPath (Join-Path $unpacked $name) -File | Copy-Item -Destination $binDir -Force
      $Singbox = Join-Path $binDir 'sing-box.exe'
    }

    Step '下载 Agent'
    $tarball = Join-Path $Tmp 'agent.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/v1/install/agent.tar.gz" -OutFile $tarball
    if (Test-Path -LiteralPath $AgentDir) { Remove-Item -Recurse -Force -LiteralPath $AgentDir }
    New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
    # Windows 10 1803 起自带的 tar 能解 .tar.gz 和 .zip，不用额外装解压工具
    tar -xzf $tarball -C $AgentDir
    if ($LASTEXITCODE -ne 0) { throw '解压 Agent 失败。' }

    Step "接入 $Server"
    $env:SINGWEB_HOME = $HomeDir
    $env:SINGWEB_INSTALLER = '1'
    & $Node --disable-warning=ExperimentalWarning $Bin join --server $Server --token $Token --singbox $Singbox
    if ($LASTEXITCODE -ne 0) { throw '接入没有成功，原因见上面。' }
    Remove-Item Env:SINGWEB_INSTALLER

    if ($env:SINGWEB_NO_SERVICE -eq '1') {
      Step '在前台运行，按 Ctrl-C 退出'
      & $Node --disable-warning=ExperimentalWarning $Bin run
      return
    }

    Step '设为登录后自动运行'
    # cmd /c 后面整体再包一层引号：cmd 会剥掉最外面那一对，里面的路径就算有空格也不会断开
    $cmd = 'cmd /c ""' + $Node + '" --disable-warning=ExperimentalWarning "' + $Bin + '" run >> "' + $Log + '" 2>&1"'
    $vbsText = @(
      "' singweb Agent：登录后在后台运行，异常退出 30 秒后再拉起来。安装脚本生成的，重新安装会覆盖它。",
      'Set sh = CreateObject("WScript.Shell")',
      ('sh.Environment("Process")("SINGWEB_HOME") = "' + $HomeDir.Replace('"', '""') + '"'),
      'Do',
      ('  code = sh.Run("' + $cmd.Replace('"', '""') + '", 0, True)'),
      '  If code = 0 Then Exit Do',
      '  WScript.Sleep 30000',
      'Loop'
    ) -join "\`r\`n"
    # 存成带 BOM 的 UTF-16：用户名是中文时 wscript 才读得对路径
    Set-Content -LiteralPath $Vbs -Value $vbsText -Encoding Unicode
    Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Vbs + '"')

    Write-Host ''
    Write-Host '装好了。Agent 已经在后台运行，网页的设备页会显示这台电脑的状态。'
    Write-Host "  日志：$Log"
    Write-Host "  本机状态：& '$Node' '$Bin' status"
    Write-Host "  卸载：删掉 $Vbs，结束 wscript.exe 和 node.exe，再运行 & '$Node' '$Bin' leave"
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $Tmp -ErrorAction SilentlyContinue
  }
}
`
}

/**
 * 查询串里的令牌能不能用。格式不对的（复制时截断了之类）也当作用不了，
 * 一样下发只报错的脚本；格式检查同时保证令牌原样拼进脚本是安全的。
 */
async function tokenOf(url: URL): Promise<{ token: string; usable: boolean }> {
  const token = url.searchParams.get('token') ?? ''
  if (!TOKEN_RE.test(token)) return { token: '', usable: false }
  return { token, usable: await store.enrollTokenUsable(token) }
}

export function registerInstallRoutes(router: Router): void {
  /**
   * 安装脚本要带一个接入令牌。令牌走查询串而不是路径：
   * 路径会进各种访问日志和 Referer，这两处都不该出现订阅级的凭据。
   */
  router.get(
    '/install/macos.sh',
    async (ctx) => {
      const { token, usable } = await tokenOf(ctx.url)
      const body = usable ? macosScript(selfBase(ctx.req), token) : staleShell()
      sendFile(ctx.res, 'text/x-shellscript; charset=utf-8', body)
    },
    'open',
  )

  router.get(
    '/install/windows.ps1',
    async (ctx) => {
      const { token, usable } = await tokenOf(ctx.url)
      const body = usable ? windowsScript(selfBase(ctx.req), token) : stalePowershell()
      sendFile(ctx.res, 'text/plain; charset=utf-8', body)
    },
    'open',
  )

  /** Agent 源码包。安装脚本自己会拉它，一般不用手动下 */
  router.get(
    '/install/agent.tar.gz',
    async (ctx) => {
      const body = await buildAgentTarball()
      sendFile(ctx.res, 'application/gzip', body)
    },
    'open',
  )
}
