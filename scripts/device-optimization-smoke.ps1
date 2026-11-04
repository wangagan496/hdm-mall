param([string]$Target = '127.0.0.1:5555')
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Hdc = Join-Path $env:DEVECO_SDK_HOME 'default/openharmony/toolchains/hdc.exe'
$Output = Join-Path $Root '_device_acceptance/optimization'
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
  $null = Invoke-Hdc @('shell','uitest','dumpLayout','-p','/data/local/tmp/hdm-optimization.json')
  $null = Invoke-Hdc @('file','recv','/data/local/tmp/hdm-optimization.json',"$Output/layout.json")
  $Layout = Get-Content -LiteralPath "$Output/layout.json" -Raw | ConvertFrom-Json
  return @(Get-Nodes $Layout)
}
function Wait-Text([string]$Text) {
  for ($Try = 0; $Try -lt 8; $Try++) {
    $script:Nodes = Read-Nodes
    if ($script:Nodes | Where-Object { $_.text -eq $Text }) { return }
    Start-Sleep -Milliseconds 400
  }
  throw "Expected visible text not found: $Text"
}
function Tap-Text([string]$Text) {
  Wait-Text $Text
  $Node = $script:Nodes | Where-Object { $_.text -eq $Text } | Select-Object -First 1
  $Bounds = [regex]::Matches($Node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
  $X = [int](($Bounds[0] + $Bounds[2]) / 2)
  $Y = [int](($Bounds[1] + $Bounds[3]) / 2)
  $null = Invoke-Hdc @('shell','uitest','uiInput','click',"$X","$Y")
}
$Existing = @(& $Hdc -t $Target fport ls)
$HadOriginal = ($Existing -join "`n") -match 'tcp:3000 tcp:3000\s+\[Reverse\]'
if (($Existing -join "`n") -match 'tcp:3000 tcp:(?!3000\b)') { throw 'Device port 3000 has a different forwarding; refusing to replace it.' }
$NodePath = (Get-Command node.exe).Source
$FixturePath = Join-Path $PSScriptRoot 'tests/device-smoke-server.ts'
$Fixture = Start-Process -FilePath $NodePath -ArgumentList @($FixturePath) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$Output/server.stdout.log" -RedirectStandardError "$Output/server.stderr.log"
$Mapped = $false
$OriginalRemoved = $false
try {
  $Ready = $false
  for ($Try = 0; $Try -lt 20; $Try++) {
    if ($Fixture.HasExited) { throw 'Isolated public catalog fixture exited before validation.' }
    try {
      $Identity = Invoke-RestMethod 'http://127.0.0.1:3101/device-fixture'
      if ($Identity.fixture -eq 'public-catalog' -and $Identity.pid -eq $Fixture.Id) { $Ready = $true; break }
    } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $Ready) { throw 'Isolated backend did not start.' }
  if ($HadOriginal) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3000'); $OriginalRemoved = $true }
  $null = Invoke-Hdc @('rport','tcp:3000','tcp:3101')
  $Mapped = $true
  $null = Invoke-Hdc @('install','-r',"$Root/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app")
  $null = Invoke-Hdc @('shell','aa','force-stop','com.hdm.mall')
  $null = Invoke-Hdc @('shell','aa','start','-a','PhoneAbility','-b','com.hdm.mall')
  Tap-Text '分类'
  Tap-Text '箱包'
  Tap-Text '收纳包'
  Wait-Text '收纳包'
  Wait-Text '价格'
  Tap-Text '价格'
  Wait-Text '收纳包'
  # 分类搜索仅出现该子类；不会混入同一父类的手提包。
  $script:Nodes = Read-Nodes
  if ($script:Nodes | Where-Object { $_.text -eq '手提包' }) { throw 'Category result includes a sibling category.' }
  Tap-Text '收纳包'
  Wait-Text '加入购物袋'
  Wait-Text '立即购买'
  if ($script:Nodes | Where-Object { $_.text -match '详情更新失败|正在更新商品详情|规格加载失败' }) { throw 'Product detail did not load.' }
  $null = Invoke-Hdc @('shell','uitest','screenCap','-p','/data/local/tmp/hdm-optimization.png')
  $null = Invoke-Hdc @('file','recv','/data/local/tmp/hdm-optimization.png',"$Output/detail.png")
  $ApiVersion = Invoke-Hdc @('shell','param','get','const.ohos.apiversion')
  Write-Output "SCRIPT $PSCommandPath RESULT API $ApiVersion emulator category, sort and product detail smoke passed"
} finally {
  try {
    if ($Mapped) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3101') }
    if ($OriginalRemoved) { $null = Invoke-Hdc @('rport','tcp:3000','tcp:3000') }
  } finally {
    if (-not $Fixture.HasExited) { Stop-Process -Id $Fixture.Id }
  }
}
