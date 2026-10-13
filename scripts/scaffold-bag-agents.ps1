<#
.SYNOPSIS
  为「代理商会」的每张卡生成一个真实的 BNB Agent Studio (bag) 工作区。

.DESCRIPTION
  每张卡 = 一个独立的 bag 工作区 = 独立钱包 + 独立 keystore + 独立端点。
  这正是设计稿里的"bag 是给每张卡办入职 + 发工资卡的系统"。

  本脚本只做**脚手架和钱包准备**，不会花任何钱、不会动任何主网资产。

  跑完之后的目录：
    D:\AgentGuild\cards\
      ├── reporta\      ← 报告师（技能 reconcile + report）
      ├── classifya\    ← 分类员（技能 classify）
      ├── detectb\      ← 侦探（技能 dedupe + detect）
      └── auditb\       ← 审计员（技能 classify + reconcile）

.NOTES
  前置条件：
    · bag ≥ 0.0.13     —— bag --version 检查
    · Node ≥ 22
    · 网络可达（bag init 会装依赖）

  时间：每张卡约 1–3 分钟（主要是装依赖）。

.EXAMPLE
  .\scripts\scaffold-bag-agents.ps1
  .\scripts\scaffold-bag-agents.ps1 -Cards reporta
#>

[CmdletBinding()]
param(
  # 只造指定的卡（默认全造）
  [string[]]$Cards,
  # 建到哪个目录
  [string]$Root = "D:\AgentGuild\cards",
  # 是否顺带激活 Pieverse LLM（零充值，$0/token）
  [switch]$SkipLlmActivate
)

$ErrorActionPreference = 'Stop'

# ── 卡牌定义（名字必须：字母开头、纯 ASCII 字母数字、≤23 字符）──
$CardDefs = @(
  @{ id = 'reporta';   label = '报告师'; skills = 'reconcile,report' },
  @{ id = 'classifya'; label = '分类员'; skills = 'classify' },
  @{ id = 'detectb';   label = '侦探';   skills = 'dedupe,detect' },
  @{ id = 'auditb';    label = '审计员'; skills = 'classify,reconcile' }
)

function Write-Step($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  ! $msg" -ForegroundColor Yellow }

# ── 0. 前置检查 ───────────────────────────────────────────
Write-Step "前置检查"

$bag = Get-Command bag -ErrorAction SilentlyContinue
if (-not $bag) {
  throw "找不到 bag。请先运行：npm install -g @bnbagent/studio-cli"
}
$ver = (bag --version) -replace '\s',''
Write-Ok "bag $ver  ($($bag.Source))"

$nodeVer = (node --version)
Write-Ok "Node $nodeVer"

# 版本必须 ≥ 0.0.13
$need = [version]'0.0.13'
try { $have = [version]$ver } catch { throw "无法解析 bag 版本：$ver" }
if ($have -lt $need) {
  throw "bag $ver 过旧，需要 ≥ 0.0.13。请运行：npm install -g @bnbagent/studio-cli@latest"
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Write-Ok "工作区根目录：$Root"

# ── 1. 逐张造卡 ───────────────────────────────────────────
$targets = if ($Cards) { $CardDefs | Where-Object { $Cards -contains $_.id } } else { $CardDefs }
if (-not $targets) { throw "没有匹配的卡牌：$($Cards -join ', ')" }

foreach ($def in $targets) {
  $dir = Join-Path $Root $def.id

  if (Test-Path $dir) {
    Write-Warn2 "$($def.label)（$($def.id)）已存在，跳过脚手架"
  } else {
    Write-Step "造卡：$($def.label)（$($def.id)）"

    Push-Location $Root
    try {
      # --no-onboard：非交互模式必须加，否则行为取决于 stdin 是否接终端
      bag init $def.id `
        --network bsc-testnet `
        --llm-provider pieverse-llm `
        --storage-provider local `
        --no-onboard
      if ($LASTEXITCODE -ne 0) { throw "bag init $($def.id) 失败（退出码 $LASTEXITCODE）" }
    } finally {
      Pop-Location
    }
    Write-Ok "工作区已生成：$dir"
  }

  # ── 钱包（幂等：已存在会被拒绝，不影响流程）──
  $agentDir = Join-Path $dir 'app\agent'
  if (-not (Test-Path $agentDir)) {
    Write-Warn2 "$agentDir 不存在，跳过钱包步骤"
    continue
  }

  Push-Location $agentDir
  try {
    Write-Step "  $($def.label)：准备钱包"

    # 密码由 OS CSPRNG 生成并私有落盘（.studio/.env.local，0600）
    # —— 永远不要把私钥/密码写进命令行或聊天记录
    $hasWallet = (bag wallet list 2>&1 | Out-String) -match '0x'
    if ($hasWallet) {
      Write-Ok "  钱包已存在，跳过创建"
    } else {
      bag wallet new --generate-password
      if ($LASTEXITCODE -ne 0) { Write-Warn2 "  钱包创建返回非零，请手动检查：cd $agentDir; bag wallet new --generate-password" }
      else { Write-Ok "  钱包已创建（密码已由系统随机生成并私有保存）" }
    }

    # 零充值激活 LLM（默认模型 auto/free 是 $0/token，不需要任何资金）
    if (-not $SkipLlmActivate) {
      Write-Host "  · 激活 Pieverse LLM（零充值）..." -ForegroundColor DarkGray
      bag llm activate 2>&1 | Out-String | Write-Verbose
      Write-Ok "  LLM 已激活（失败也不阻塞，可稍后手动重试）"
    }
  } catch {
    Write-Warn2 "  $($def.label) 的钱包/LLM 步骤出错：$_"
  } finally {
    Pop-Location
  }

  Write-Host "  · 卡牌技能（写进 runWork 的业务面）：$($def.skills)" -ForegroundColor DarkGray
}

# ── 2. 汇总 ───────────────────────────────────────────────
Write-Step "汇总"
foreach ($def in $targets) {
  $dir = Join-Path $Root $def.id
  $agent = Join-Path $dir 'app\agent'
  $exists = Test-Path $agent
  $mark = if ($exists) { '✓' } else { '✗' }
  Write-Host "  $mark $($def.label.PadRight(4))  $dir"
}

Write-Host @"

────────────────────────────────────────────────────────────
下一步：
  1) 检查每张卡的健康状况
       cd $Root\$($targets[0].id)
       bag doctor

  2) 本地跑起来（每张卡换一个端口，否则会打架）
       cd $Root\$($targets[0].id); bag dev --port 9001

  3) 验证协议面（报价是链下签名，零 gas）
       curl http://localhost:9001/.well-known/agent-card.json

  4) 把卡接入游戏 —— 见 scripts/bag-adapter.md

注意：
  · 部署（不是本地跑）才需要 Bun 1.3+
  · 每张卡要真正在链上收付款时，需要 tBNB(gas) + 测试网 U(托管)，
    从官方 Telegram 机器人领：https://t.me/bnbchain_official_bot
    测试网 U 分两条 rail，走 ERC-8183 的认准 18 位小数那条
────────────────────────────────────────────────────────────
"@ -ForegroundColor DarkGray
