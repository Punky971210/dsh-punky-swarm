<#
.SYNOPSIS
  将 dsh-punky-swarm（新引擎）一键装进指定的 DSH profile。

.DESCRIPTION
  做四件事：
    1) 在 <profile> 的 node_modules 里建立到引擎源码目录的 link（pnpm link:）
    2) 把 dsh-punky-swarm 加进 package.json 的 dsh.profile.bundles
    3) pnpm install（只在需要时；网络不通也能跑，因为 link: 不下载）
    4) dsh --profile <name> --dump-config 验证装配

  为什么用 link: 而不是 npm 包：当前引擎未发版，link: 让源码改动立即生效，
  且不依赖 registry（网络不通也能装）。

.PARAMETER ProfileName
  目标 profile 名（~/.dsh/profiles 下的目录名）。默认 smoke-engine。

.PARAMETER EnginePath
  引擎包源码目录。默认 D:/dsh/Punky-multi-agent-engine/packages/dsh-punky-swarm。

.PARAMETER SkipVerify
  跳过最后的 --dump-config 验证。

.EXAMPLE
  .\install-profile.ps1
  .\install-profile.ps1 -ProfileName my-swarm

.NOTES
  需 Node >= 22（引擎 package.json 的 engines 约束）与 pnpm。
  脚本幂等：重复执行只会更新已有的 link 与 bundles 条目。
#>
[CmdletBinding()]
param(
  [string]$ProfileName = 'smoke-engine',
  [string]$EnginePath = 'D:/dsh/Punky-multi-agent-engine/packages/dsh-punky-swarm',
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$ProfileName"
$pkgJson = Join-Path $profileDir 'package.json'
$enginePkg = Join-Path $EnginePath 'package.json'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

# ── 0. 前置检查 ──────────────────────────────────────────────────────
Write-Step "前置检查"

if (-not (Test-Path $enginePkg)) {
  throw "找不到引擎包：$enginePkg`n（用 -EnginePath 指定正确路径）"
}
$engine = Get-Content $enginePkg -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Ok "引擎 $($engine.name)@$($engine.version)"

try {
  $nodeVer = (& node --version).Trim()
  Write-Ok "node $nodeVer"
  $major = [int]($nodeVer.TrimStart('v').Split('.')[0])
  if ($major -lt 22) { Write-Warn2 "引擎要求 node >= 22，当前 $nodeVer —— 可能启动失败" }
} catch { throw "找不到 node（引擎要求 >= 22）" }

try { $pnpmVer = (& pnpm --version).Trim(); Write-Ok "pnpm $pnpmVer" }
catch { throw "找不到 pnpm（需要它来解析 link: 协议；npm 不支持 link:）" }

# ── 1. 建 profile 目录 ────────────────────────────────────────────────
Write-Step "准备 profile：$profileDir"
if (-not (Test-Path $profileDir)) {
  New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
  Write-Ok "已创建目录"
} else { Write-Ok "目录已存在" }

# ── 2. 写/更新 package.json ─────────────────────────────────────────
Write-Step "写 package.json"

if (Test-Path $pkgJson) {
  $cfg = Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
  $cfg = [pscustomobject]@{
    name    = "dsh-profile-$ProfileName"
    private = $true
    dependencies = [pscustomobject]@{}
    dsh     = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }
  }
}

# 2a. 依赖：加 link:（保留已有依赖）
$linkSpec = "link:$($EnginePath -replace '\\','/')"
if (-not $cfg.PSObject.Properties['dependencies'] -or $null -eq $cfg.dependencies) {
  $cfg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$cfg.dependencies | Add-Member -NotePropertyName $engine.name -NotePropertyValue $linkSpec -Force
Write-Ok "依赖 $($engine.name) = $linkSpec"

# 2b. bundles：确保四项齐全（base / web-app / agent-team-profile / 引擎）
if (-not $cfg.PSObject.Properties['dsh'] -or $null -eq $cfg.dsh) {
  $cfg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $cfg.dsh.PSObject.Properties['profile'] -or $null -eq $cfg.dsh.profile) {
  $cfg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }) -Force
}
$required = @(
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  $engine.name
)
$current = @($cfg.dsh.profile.bundles | Where-Object { $_ })
$merged = @($current)
foreach ($b in $required) { if ($merged -notcontains $b) { $merged += $b } }
$cfg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $merged -Force
Write-Ok "bundles：$($merged -join ', ')"

$cfg | ConvertTo-Json -Depth 12 | Set-Content $pkgJson -Encoding UTF8
Write-Ok "已写入 $pkgJson"

# ── 3. cordis.yml（空数组即可；配置走 cordis.patch.yml）────────────────
$cordisYml = Join-Path $profileDir 'cordis.yml'
if (-not (Test-Path $cordisYml)) {
  @(
    '# dsh profile root — an empty entry list. The tree is composed as patches:',
    "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any",
    '# --patch overlays. Edit cordis.patch.yml, not this file.',
    '[]'
  ) | Set-Content $cordisYml -Encoding UTF8
  Write-Ok "已写 cordis.yml（[]）"
} else { Write-Ok "cordis.yml 已存在" }

# ── 4. pnpm install ──────────────────────────────────────────────────
Write-Step "pnpm install（link: 不下载，秒级完成）"
Push-Location $profileDir
try {
  & pnpm install --reporter=append-only --prefer-offline 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（exit $LASTEXITCODE）" }
} finally { Pop-Location }
Write-Ok "依赖已就位"

$linked = Join-Path $profileDir "node_modules\$($engine.name)"
if (-not (Test-Path $linked)) { throw "install 后仍找不到 $linked" }
$target = (Get-Item $linked).Target
Write-Ok "已链接到 $target"

# ── 5. 验证装配 ──────────────────────────────────────────────────────
if (-not $SkipVerify) {
  Write-Step "验证装配（--dump-config）"
  # 绕过 dsh.ps1 包装直接跑 node —— ps1 在 stderr 非空时会抛 NativeCommandError 并虚构 app-boot 报错位置
  $dshBin = Join-Path $dshHome '..\DSH\kernel\0.2.1-rc.2\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (-not (Test-Path $dshBin)) {
    $candidate = Get-ChildItem "D:\DSH\kernel" -Recurse -Filter 'bin.js' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'dsh\\lib\\bin\.js$' } | Select-Object -First 1
    if ($candidate) { $dshBin = $candidate.FullName }
  }
  if (Test-Path $dshBin) {
    $out = & node $dshBin --profile $ProfileName --dump-config 2>&1
    $txt = ($out | Out-String)
    $bundleCount = ([regex]::Matches($txt, '(?m)^# == ')).Count
    $pending = ([regex]::Matches($txt, 'pending')).Count
    $swarmHits = ([regex]::Matches($txt, [regex]::Escape($engine.name))).Count
    Write-Ok "分段头 $bundleCount 行 / pending $pending 次 / $($engine.name) $swarmHits 次"
    if ($pending -gt 0) { Write-Warn2 "有 pending 项，装配未完全就绪" }
    if ($swarmHits -eq 0) { Write-Warn2 "配置里找不到 $($engine.name) —— bundles 可能未生效" }
    if ($txt -match "not found") { Write-Warn2 "有 patch 悬空引用（看输出里的 patch: entry ... not found）" }
  } else {
    Write-Warn2 "找不到 dsh 的 bin.js，跳过验证（用 -SkipVerify 静默）"
  }
}

# ── 完成 ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "完成。启动：" -ForegroundColor Green
Write-Host "  dsh --profile $ProfileName               # 起 GUI" -ForegroundColor Gray
Write-Host "  dsh --profile $ProfileName `"任务`"        # headless 跑一条" -ForegroundColor Gray
Write-Host ''
Write-Host "⚠ 若要用真 LLM（headless），需在启动环境里注入 key：" -ForegroundColor Yellow
Write-Host '  $env:DEEPSEEK_API_KEY = "<your-key>"' -ForegroundColor Gray
Write-Host '  （key 也可写在 ~/.dsh/.credentials.yaml 的 refs 段，但 headless 不自动读它）' -ForegroundColor Gray
