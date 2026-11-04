param([string]$Target = '127.0.0.1:5555')
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Hdc = Join-Path $env:DEVECO_SDK_HOME 'default/openharmony/toolchains/hdc.exe'
$Output = Join-Path $Root '_device_acceptance/inventory'
New-Item -ItemType Directory -Path $Output -Force | Out-Null
function Invoke-Hdc([string[]]$Arguments) {
  $Response = @(& $Hdc -t $Target @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0 -or ($Response -join "`n") -match '\[Fail\]|error: failed') { throw ($Response -join "`n") }
  return $Response
}
function Get-Nodes($Node) {
  if ($null -ne $Node.attributes) { $Node.attributes }
  foreach ($Child in $Node.children) { Get-Nodes $Child }
}
function Read-Nodes {
  $null = Invoke-Hdc @('shell','uitest','dumpLayout','-p','/data/local/tmp/hdm-inventory.json')
  $null = Invoke-Hdc @('file','recv','/data/local/tmp/hdm-inventory.json',"$Output/layout.json")
  return @(Get-Nodes (Get-Content -LiteralPath "$Output/layout.json" -Raw | ConvertFrom-Json))
}
function Wait-Text([string]$Text) {
  for ($Try = 0; $Try -lt 10; $Try++) {
    $script:Nodes = Read-Nodes
    if ($script:Nodes | Where-Object { $_.text -eq $Text }) { return }
    Start-Sleep -Milliseconds 400
  }
  throw "Expected visible text not found: $Text"
}
function Operate-Node($Node, [string]$Value = '') {
  if ($null -eq $Node) { throw 'Expected node not found' }
  $Bounds = [regex]::Matches($Node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
  $X = [int](($Bounds[0] + $Bounds[2]) / 2)
  $Y = [int](($Bounds[1] + $Bounds[3]) / 2)
  if ($Value) { $null = Invoke-Hdc @('shell','uitest','uiInput','inputText',"$X","$Y",$Value) }
  else { $null = Invoke-Hdc @('shell','uitest','uiInput','click',"$X","$Y") }
}
function Tap-Text([string]$Text) {
  Wait-Text $Text
  Operate-Node ($script:Nodes | Where-Object { $_.text -eq $Text } | Select-Object -First 1)
}
function Input-Type([string]$Type, [int]$Index, [string]$Value) {
  $Nodes = @(Read-Nodes | Where-Object { $_.type -eq $Type })
  Operate-Node $Nodes[$Index] $Value
}
$Existing = @(& $Hdc -t $Target fport ls)
$HadOriginal = ($Existing -join "`n") -match 'tcp:3000 tcp:3000\s+\[Reverse\]'
if (($Existing -join "`n") -match 'tcp:3000 tcp:(?!3000\b)') { throw 'Device port 3000 has different forwarding.' }
$FixturePath = Join-Path $PSScriptRoot 'tests/device-inventory-server.ts'
$Fixture = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @($FixturePath) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$Output/server.stdout.log" -RedirectStandardError "$Output/server.stderr.log"
$Mapped = $false
$OriginalRemoved = $false
try {
  $Ready = $false
  for ($Try = 0; $Try -lt 20; $Try++) {
    if ($Fixture.HasExited) { throw 'Isolated fixture exited before validation.' }
    try { $null = Invoke-RestMethod 'http://127.0.0.1:3102/health'; $Ready = $true; break } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $Ready) { throw 'Isolated backend did not start.' }
  if ($HadOriginal) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3000'); $OriginalRemoved = $true }
  $null = Invoke-Hdc @('rport','tcp:3000','tcp:3102'); $Mapped = $true
  $null = Invoke-Hdc @('install','-r',"$Root/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app")
  $null = Invoke-Hdc @('shell','aa','force-stop','com.hdm.mall')
  $null = Invoke-Hdc @('shell','aa','start','-a','PhoneAbility','-b','com.hdm.mall')
  Wait-Text '爆款推荐'
  for ($NavigationTry = 0; $NavigationTry -lt 3; $NavigationTry++) {
    Tap-Text '我的'
    $Nodes = Read-Nodes
    if ($Nodes | Where-Object { $_.text -eq '立即登录' }) { break }
    Start-Sleep -Milliseconds 500
  }
  Tap-Text '立即登录'
  Wait-Text '账号密码登录'
  Input-Type 'TextInput' 0 'stock_smoke'
  Input-Type 'TextInput' 1 'Smoke-password-123'
  $null = Invoke-Hdc @('shell','uitest','uiInput','keyEvent','Back')
  $Nodes = Read-Nodes
  Operate-Node ($Nodes | Where-Object { $_.type -eq 'Checkbox' } | Select-Object -First 1)
  Tap-Text '登录'
  Tap-Text '库存管理'
  Wait-Text '可售库存：20'
  Tap-Text '调整库存'
  Wait-Text '当前可售库存：20'
  Input-Type 'TextInput' 0 '3'
  Input-Type 'TextArea' 0 'device smoke stock count'
  $null = Invoke-Hdc @('shell','uitest','uiInput','keyEvent','Back')
  Tap-Text '提交库存调整'
  Tap-Text '确认调整'
  Wait-Text '调整已记录，本次调整后库存为 23'
  Wait-Text '可售库存：23'
  Tap-Text '刷新库存'
  Wait-Text '可售库存：23'
  Tap-Text '调整库存'
  Wait-Text '当前可售库存：23'
  Tap-Text '取消编辑'
  $Login = Invoke-RestMethod 'http://127.0.0.1:3102/login' -Method Post -ContentType 'application/json' -Body (@{account='stock_smoke'; password='Smoke-password-123'} | ConvertTo-Json)
  $Headers = @{ Authorization = 'Bearer ' + $Login.result.token }
  $Inventory = Invoke-RestMethod 'http://127.0.0.1:3102/merchant/inventory?skuId=hdm-1-a' -Headers $Headers
  $Movements = Invoke-RestMethod 'http://127.0.0.1:3102/merchant/inventory/hdm-1-a/movements' -Headers $Headers
  $Adjustments = @($Movements.result.items | Where-Object { $_.kind -eq 'adjust' })
  if ($Inventory.result.items[0].stock -ne 23 -or $Inventory.result.items[0].difference -ne 0 -or $Adjustments.Count -ne 1 -or $Adjustments[0].delta -ne 3) { throw 'Backend inventory proof failed' }
  $null = Invoke-Hdc @('shell','uitest','screenCap','-p','/data/local/tmp/hdm-inventory.png')
  $null = Invoke-Hdc @('file','recv','/data/local/tmp/hdm-inventory.png',"$Output/inventory.png")
  Write-Output "SCRIPT $PSCommandPath RESULT emulator merchant login, stock 20->23, refresh, next edit baseline and single matching adjustment passed"
} finally {
  try {
    if ($Mapped) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3102') }
    if ($OriginalRemoved) { $null = Invoke-Hdc @('rport','tcp:3000','tcp:3000') }
  } finally { if (-not $Fixture.HasExited) { Stop-Process -Id $Fixture.Id } }
}
