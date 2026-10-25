param([ValidateSet('install','dump','tap','input','back','capture')][string]$Action = 'dump', [string]$Text = '', [string]$Value = '', [int]$Index = 0, [string]$Type = '', [string]$Target = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$hdc = Join-Path $env:DEVECO_SDK_HOME 'default/openharmony/toolchains/hdc.exe'
$out = Join-Path $root '_device_acceptance'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$targets = @(& $hdc list targets | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ([string]::IsNullOrWhiteSpace($Target)) {
  if ($targets.Count -ne 1) {
    throw "Found $($targets.Count) HDC targets. Pass -Target with the intended simulator serial."
  }
  $Target = $targets[0]
} elseif ($Target -notin $targets) {
  throw "The requested HDC target is not connected: $Target"
}
function Invoke-Hdc([string[]]$Arguments) {
  $result = & $hdc -t $Target @Arguments 2>&1
  $result | Write-Output
  if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -match '\[Fail\]|error: failed') { throw 'hdc command failed' }
}
function Read-Layout {
  Invoke-Hdc @('shell','uitest','dumpLayout','-p','/data/local/tmp/hdm-trade-layout.json')
  Invoke-Hdc @('file','recv','/data/local/tmp/hdm-trade-layout.json',(Join-Path $out 'trade-layout.json'))
  $script:layout = Get-Content -LiteralPath (Join-Path $out 'trade-layout.json') -Raw | ConvertFrom-Json
}
function Get-Nodes($node) {
  if ($null -ne $node.attributes) { $node.attributes }
  foreach ($child in $node.children) { Get-Nodes $child }
}
switch ($Action) {
  'install' {
    $forwardings = @(& $hdc -t $Target fport ls | ForEach-Object { $_.Trim() })
    $forwardPattern = '^' + [regex]::Escape($Target) + '\s+tcp:3000 tcp:3000\s+\[Reverse\]$'
    if (-not ($forwardings | Where-Object { $_ -match $forwardPattern })) {
      Invoke-Hdc @('rport','tcp:3000','tcp:3000')
    }
    Invoke-Hdc @('install','-r',[IO.Path]::GetFullPath((Join-Path $root 'mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app')))
    Invoke-Hdc @('shell','aa','start','-a','PhoneAbility','-b','com.hdm.mall')
  }
  'dump' {
    Read-Layout
    Get-Nodes $script:layout | Where-Object { $_.text -or $_.type -match 'Input|Checkbox' } |
      Select-Object text,type,bounds,enabled | ConvertTo-Json -Depth 3
  }
  { $_ -in 'tap','input' } {
    Read-Layout
    $matches = @(Get-Nodes $script:layout | Where-Object { if ($Type) { $_.type -eq $Type } else { $_.text -eq $Text } })
    if ($matches.Count -le $Index) { throw "Cannot find visible text: $Text" }
    $bounds = [regex]::Matches($matches[$Index].bounds, '\d+') | ForEach-Object { [int]$_.Value }
    if ($bounds.Count -ne 4) { throw 'Unexpected bounds' }
    $x = [int](($bounds[0] + $bounds[2]) / 2)
    $y = [int](($bounds[1] + $bounds[3]) / 2)
    if ($Action -eq 'tap') { Invoke-Hdc @('shell','uitest','uiInput','click',"$x","$y") }
    else { Invoke-Hdc @('shell','uitest','uiInput','inputText',"$x","$y",$Value) }
  }
  'back' { Invoke-Hdc @('shell','uitest','uiInput','keyEvent','Back') }
  'capture' {
    Invoke-Hdc @('shell','uitest','screenCap','-p','/data/local/tmp/hdm-trade.png')
    Invoke-Hdc @('file','recv','/data/local/tmp/hdm-trade.png',(Join-Path $out 'trade.png'))
  }
}
Write-Output "SCRIPT $PSCommandPath RESULT $Action completed on $Target"
