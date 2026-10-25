param(
  [switch]$SkipH5,
  [switch]$SkipNative,
  [switch]$SyncH5,
  [switch]$Incremental,
  [string]$HvigorPath = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$h5Root = Join-Path $projectRoot 'shoph5-vue3'
$nativeRoot = Join-Path $projectRoot 'mixed-development-h5'

function Invoke-Checked {
  param(
    [string]$Label,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  Write-Host "==> $Label"
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

if (-not $SkipH5) {
  if (-not (Test-Path (Join-Path $h5Root 'package.json'))) {
    throw "H5 project was not found: $h5Root"
  }

  Invoke-Checked 'H5 type-check' 'pnpm.cmd' @('run', 'type-check') $h5Root
  Invoke-Checked 'H5 production build' 'pnpm.cmd' @('run', 'build-only') $h5Root

  if ($SyncH5) {
    Invoke-Checked 'Sync H5 rawfile' 'pnpm.cmd' @('run', 'sync:rawfile') $h5Root
  }
}

if (-not $SkipNative) {
  $sdkRoot = $env:DEVECO_SDK_HOME
  if ([string]::IsNullOrWhiteSpace($sdkRoot) -or -not (Test-Path $sdkRoot)) {
    throw 'DEVECO_SDK_HOME is not set to an existing DevEco SDK directory.'
  }

  if ([string]::IsNullOrWhiteSpace($HvigorPath)) {
    $devEcoRoot = ${env:DevEco Studio}
    if ([string]::IsNullOrWhiteSpace($devEcoRoot)) {
      throw 'DevEco Studio root was not found. Pass -HvigorPath explicitly.'
    }

    $hvigorCandidates = @(
      (Join-Path $devEcoRoot 'tools\hvigor\bin\hvigorw.bat'),
      (Join-Path (Split-Path -Parent $devEcoRoot) 'tools\hvigor\bin\hvigorw.bat')
    )
    $HvigorPath = $hvigorCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  }

  if (-not (Test-Path $HvigorPath)) {
    throw "Hvigor wrapper was not found: $HvigorPath"
  }

  $nativeArguments = @('assembleApp', '--mode', 'project')
  if (-not $Incremental) {
    $nativeArguments += '--no-incremental'
  }
  Invoke-Checked 'HarmonyOS assembleApp' $HvigorPath $nativeArguments $nativeRoot

  $signedPackages = @(Get-ChildItem -Path (Join-Path $nativeRoot 'build\outputs') -Recurse -File -Filter '*-all-signed.app' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if ($signedPackages.Count -eq 0) {
    throw 'assembleApp succeeded, but no *-all-signed.app package was found.'
  }

  $package = $signedPackages[0]
  Write-Host '==> Signed app package'
  Write-Host ("Path: {0}" -f $package.FullName)
  Write-Host ("Size: {0:N0} bytes" -f $package.Length)
  Write-Host ("Updated: {0:yyyy-MM-dd HH:mm:ss}" -f $package.LastWriteTime)
}

Write-Host 'Project verification completed.'
