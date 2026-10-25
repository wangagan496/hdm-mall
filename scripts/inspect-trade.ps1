param([string[]]$Paths = @())
$ErrorActionPreference = 'Stop'
if ($Paths.Count -eq 0) {
  $Paths = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '../server') -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/](node_modules|data)[\\/]' } | ForEach-Object FullName)
  $Paths += $PSCommandPath
  $Paths += Join-Path $PSScriptRoot 'verify-trade.ps1'
  $changed = git -C (Split-Path -Parent $PSScriptRoot) diff --name-only
  $Paths += $changed | Where-Object { $_ -match '\.(ets|ts)$' -or $_ -eq '.gitignore' } |
    ForEach-Object { Join-Path (Split-Path -Parent $PSScriptRoot) $_ }
  $Paths += Join-Path $PSScriptRoot '../mixed-development-h5/features/mine/src/main/ets/presentation/views/FamilyView.ets'
}
foreach ($target in $Paths) {
  $item = Get-Item -LiteralPath $target
  Write-Output ("FILE {0} BYTES {1}" -f $item.FullName, $item.Length)
  Get-Content -LiteralPath $item.FullName -TotalCount 3
}
Write-Output "SCRIPT $PSCommandPath RESULT inspection completed"
