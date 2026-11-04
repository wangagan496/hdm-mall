param([switch]$ProfileOnly, [switch]$RecordFiles)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root
if ($RecordFiles) {
  $Paths = @(& git -c core.quotepath=false diff --name-only --diff-filter=AM) + @(& git -c core.quotepath=false ls-files --others --exclude-standard)
  foreach ($Relative in $Paths | Sort-Object -Unique) {
    if ($Relative -notmatch '\.(ets|ts|vue|mjs|ps1|json|html|md)$') { continue }
    $Item = Get-Item -LiteralPath (Join-Path $Root $Relative)
    $First = ((Get-Content -LiteralPath $Item.FullName -TotalCount 2) -join ' ').Replace("`t", ' ')
    if ($First.Length -gt 180) { $First = $First.Substring(0, 180) }
    Write-Output ("FILE {0} BYTES {1} FIRST {2}" -f $Item.FullName, $Item.Length, $First)
  }
  foreach ($Relative in @(& git -c core.quotepath=false diff --name-only --diff-filter=D)) {
    Write-Output ("DELETED {0} EXISTS {1}" -f (Join-Path $Root $Relative), (Test-Path -LiteralPath (Join-Path $Root $Relative)))
  }
}
[string[]]$Tests = if ($ProfileOnly) { @('scripts/tests/profile-save.test.mjs') } else { @(Get-ChildItem -LiteralPath "$PSScriptRoot/tests" -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName) }
& node --test @Tests
$Code = $LASTEXITCODE
Write-Output "SCRIPT $PSCommandPath RESULT optimization regression exit=$Code"
exit $Code
