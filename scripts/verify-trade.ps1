param([switch]$NativeOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
function Invoke-Step([string]$Directory, [string]$Command, [string[]]$Arguments) {
  Push-Location $Directory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Command $Arguments" }
  } finally { Pop-Location }
}
if ($NativeOnly) {
  & (Join-Path $PSScriptRoot 'verify-project.ps1') -SkipH5 -Incremental
} else {
  Invoke-Step (Join-Path $root 'server') 'npm.cmd' @('run','check')
  Invoke-Step (Join-Path $root 'server') 'npm.cmd' @('test')
  Invoke-Step (Join-Path $root 'shoph5-vue3') 'pnpm.cmd' @('run','lint')
  Invoke-Step (Join-Path $root 'shoph5-vue3') 'pnpm.cmd' @('run','build:mobile')
}
Write-Output "SCRIPT $PSCommandPath RESULT trade verification completed"
