$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$NativeRoot = Join-Path $Root 'mixed-development-h5'
$LogRoot = Join-Path $env:TEMP 'hdm-client-environment-check'
$null = New-Item -ItemType Directory -Path $LogRoot -Force
$Hvigor = Join-Path (Split-Path -Parent ${env:DevEco Studio}) 'tools/hvigor/bin/hvigorw.bat'
if (-not (Test-Path -LiteralPath $Hvigor)) { throw 'DevEco Hvigor was not found.' }
$Names = @('HDM_APP_ENV', 'HDM_API_BASE_URL', 'HDM_DECISION_SERVICE_URL', 'HDM_DEMO_ORDER_FLOW', 'VITE_API_BASE_URL')
$Previous = @{}
foreach ($Name in $Names) { $Previous[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }

function Invoke-RejectedRelease {
  param([string]$Label, [string]$Expected)
  $Log = Join-Path $LogRoot "$Label.log"
  Push-Location $NativeRoot
  try {
    & $Hvigor assembleApp --mode project -p buildMode=release --no-daemon *> $Log
    $Code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($Code -eq 0 -or -not (Select-String -LiteralPath $Log -SimpleMatch $Expected -Quiet)) {
    throw "Release rejection check failed: $Label; log=$Log"
  }
  Write-Output "CHECK $Label rejected by actual Hvigor configuration"
}

try {
  foreach ($Name in $Names) { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
  Invoke-RejectedRelease 'missing-origin' 'HDM_API_BASE_URL is required'
  $env:HDM_APP_ENV = 'development'
  Invoke-RejectedRelease 'release-development' 'Release build requires'
  $env:HDM_APP_ENV = 'production'
  $env:HDM_API_BASE_URL = 'https://127.0.0.1:3000'
  Invoke-RejectedRelease 'release-loopback' 'public DNS hostname'
  # 仅用于编译检查的虚构域名，不部署、不请求后端，也不代表生产配置已验收。
  $env:HDM_API_BASE_URL = 'https://api.fixture.com'
  $env:HDM_DEMO_ORDER_FLOW = 'true'
  Invoke-RejectedRelease 'release-demo' 'Demo order flow is forbidden'
  $env:HDM_DEMO_ORDER_FLOW = 'false'
  $ReleaseLog = Join-Path $LogRoot 'release-fixture.log'
  & (Join-Path $PSScriptRoot 'verify-project.ps1') -BuildMode release -Incremental *> $ReleaseLog
  $Profile = Get-Content -LiteralPath (Join-Path $NativeRoot 'commons/constants/build/default/generated/profile/default/BuildProfile.ets') -Raw
  foreach ($Expected in @("APP_ENV = 'production'", "API_BASE_URL = 'https://api.fixture.com'", "DECISION_SERVICE_URL = ''", 'DEMO_ORDER_FLOW = false', "BUILD_MODE_NAME = 'release'")) {
    if (-not $Profile.Contains($Expected)) { throw "Release generated profile mismatch: $Expected" }
  }
  if ($Profile -match '127\.0\.0\.1|10\.0\.2\.2') { throw 'Release profile contains development endpoints.' }
  $Web = Get-Content -LiteralPath (Join-Path $NativeRoot 'features/mine/src/main/resources/rawfile/index.html') -Raw
  if ($Web -match '127\.0\.0\.1:3000|10\.0\.2\.2:8765') { throw 'Mobile H5 contains previous development endpoints.' }
  Get-Content -LiteralPath $ReleaseLog -Tail 9
  Write-Output 'CHECK release fixture built with production fields, demo disabled and previous development endpoints absent'
  foreach ($Name in $Names) { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
  $DebugLog = Join-Path $LogRoot 'debug-restore.log'
  & (Join-Path $PSScriptRoot 'verify-project.ps1') -BuildMode debug -SkipH5 -Incremental *> $DebugLog
  $Profile = Get-Content -LiteralPath (Join-Path $NativeRoot 'commons/constants/build/default/generated/profile/default/BuildProfile.ets') -Raw
  if (-not $Profile.Contains("APP_ENV = 'development'") -or -not $Profile.Contains("API_BASE_URL = 'http://127.0.0.1:3000'")) {
    throw 'Debug environment was not regenerated after the release build.'
  }
  Get-Content -LiteralPath $DebugLog -Tail 9
  Write-Output "SCRIPT $PSCommandPath RESULT release guard and fixture build passed; debug package restored; logs=$LogRoot"
} finally {
  foreach ($Name in $Names) {
    if ($null -eq $Previous[$Name]) { Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($Name, $Previous[$Name], 'Process') }
  }
}
