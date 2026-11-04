param([switch]$SkipH5)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Log = Join-Path $env:TEMP 'hdm-optimization-build.log'
Write-Output ("SCRIPT {0}" -f $PSCommandPath)
try {
  & "$PSScriptRoot\verify-project.ps1" -SkipH5:$SkipH5 -SyncH5 -Incremental *> $Log
  Get-Content -LiteralPath $Log -Tail 9
  Write-Output "RESULT build passed; log=$Log"
} catch {
  Select-String -LiteralPath $Log -Pattern 'ERROR|Error|error TS|ArkTS:ERROR' -Context 0,5
  Write-Output "RESULT build failed; log=$Log"
  exit 1
}
