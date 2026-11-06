param([string]$Target = '127.0.0.1:5555', [switch]$ShipProbe, [switch]$PaginationProbe, [switch]$RelationsProbe, [switch]$S3)
$ErrorActionPreference = 'Stop'
if (@($ShipProbe, $PaginationProbe, $RelationsProbe, $S3 | Where-Object { $_ }).Count -gt 1) { throw 'Choose only one regression mode.' }
$StartedAt = Get-Date
$Mode = if ($S3) { 'S3' } elseif ($RelationsProbe) { 'RelationsProbe' } elseif ($PaginationProbe) { 'PaginationProbe' } elseif ($ShipProbe) { 'ShipProbe' } else { 'Full' }
$Root = Split-Path $PSScriptRoot -Parent
$Hdc = Join-Path $env:DEVECO_SDK_HOME 'default/openharmony/toolchains/hdc.exe'
$Output = Join-Path $Root $(if ($S3) { '_device_acceptance/s3' } elseif ($RelationsProbe) { '_device_acceptance/relation-pagination' } elseif ($PaginationProbe) { '_device_acceptance/order-pagination' } else { '_device_acceptance/trade-regression' })
New-Item -ItemType Directory -Path $Output -Force | Out-Null
$Base = 'http://127.0.0.1:3103'
$Password = 'Device-trade-123'
$Tokens = @{}
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
  $null = Invoke-Hdc @('shell','uitest','dumpLayout','-p','/data/local/tmp/hdm-regression.json')
  $null = Invoke-Hdc @('file','recv','/data/local/tmp/hdm-regression.json',"$Output/layout.json")
  return @(Get-Nodes (Get-Content -LiteralPath "$Output/layout.json" -Raw | ConvertFrom-Json))
}
function Find-Text([string]$Text) {
  return $script:Nodes | Where-Object { ($_.text -eq $Text -or $_.description -eq $Text) -and $_.visible -ne 'false' } | Select-Object -First 1
}
function Wait-Text([string]$Text) {
  for ($Try = 0; $Try -lt 12; $Try++) {
    $script:Nodes = Read-Nodes
    if (Find-Text $Text) { return }
    Start-Sleep -Milliseconds 300
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
  Operate-Node (Find-Text $Text)
}
function Tap-CellArrow([string]$Text) {
  Wait-Text $Text
  $Bounds = [regex]::Matches((Find-Text $Text).bounds, '\d+') | ForEach-Object { [int]$_.Value }
  $Y = [int](($Bounds[1] + $Bounds[3]) / 2)
  $Arrow = @($script:Nodes | Where-Object {
    if ($_.type -ne 'Image' -or $_.clickable -ne 'true') { return $false }
    $Box = [regex]::Matches($_.bounds, '\d+') | ForEach-Object { [int]$_.Value }
    return $Box[1] -le $Y -and $Box[3] -ge $Y
  })
  if ($Arrow.Count -ne 1) { throw "Cell arrow is not uniquely identified: $Text" }
  Operate-Node $Arrow[0]
}
function Scroll-Text([string]$Text) {
  for ($Try = 0; $Try -lt 8; $Try++) {
    $script:Nodes = Read-Nodes
    $Node = Find-Text $Text
    if ($Node) { Operate-Node $Node; return }
    $null = Invoke-Hdc @('shell','uitest','uiInput','swipe','660','2350','660','900','600')
  }
  throw "Expected scroll target not found: $Text"
}
function Input-Type([string]$Type, [int]$Index, [string]$Value) {
  $Inputs = @(Read-Nodes | Where-Object { $_.type -eq $Type -and $_.visible -ne 'false' })
  Operate-Node $Inputs[$Index] $Value
}
function Back { $null = Invoke-Hdc @('shell','uitest','uiInput','keyEvent','Back') }
function Mine {
  $null = Invoke-Hdc @('shell','aa','force-stop','com.hdm.mall')
  $null = Invoke-Hdc @('shell','aa','start','-a','PhoneAbility','-b','com.hdm.mall')
  Wait-Text '爆款推荐'
  for ($Try = 0; $Try -lt 3; $Try++) {
    Tap-Text '我的'
    $script:Nodes = Read-Nodes
    if ((Find-Text '立即登录') -or (Find-Text '编辑资料')) { return }
    Start-Sleep -Milliseconds 400
  }
  throw 'Mine navigation did not complete'
}
function Login([string]$Account) {
  Mine
  if (-not (Find-Text '立即登录')) {
    # 当前 UiTest 布局不输出 Image.accessibilityText；“我的”仅设置图标为可点击图片。
    $Settings = @($script:Nodes | Where-Object { $_.type -eq 'Image' -and $_.clickable -eq 'true' -and $_.visible -ne 'false' })
    if ($Settings.Count -ne 1) { throw 'Settings image is not uniquely identified' }
    Operate-Node $Settings[0]
    Tap-CellArrow '退出登录'
    Tap-Text '确定'
  }
  Tap-Text '立即登录'
  Wait-Text '账号密码登录'
  Input-Type 'TextInput' 0 $Account
  Input-Type 'TextInput' 1 $Password
  Back
  $Inputs = @(Read-Nodes | Where-Object { $_.type -eq 'Checkbox' })
  if ($Inputs[0].checked -ne 'true') { Operate-Node $Inputs[0] }
  Tap-Text '登录'
  Wait-Text $Account
  Write-Output "CHECK device signed in as $Account"
}
function Api([string]$Account, [string]$Path, [string]$Method = 'Get', $Body = $null) {
  if (-not $Tokens.ContainsKey($Account)) {
    $LoginResult = Invoke-RestMethod "$Base/login" -Method Post -ContentType 'application/json' -Body (@{account=$Account; password=$Password} | ConvertTo-Json)
    $Tokens[$Account] = $LoginResult.result.token
  }
  $Args = @{Uri="$Base$Path"; Method=$Method; Headers=@{Authorization='Bearer '+$Tokens[$Account]}}
  if ($null -ne $Body) { $Args.ContentType='application/json'; $Args.Body=$Body | ConvertTo-Json -Depth 8 }
  return (Invoke-RestMethod @Args).result
}
function Orders { return @( (Api 'device_buyer' '/member/order?pageSize=100').items ) }
function Assert-State([string]$Id, [int]$State) {
  for ($Try = 0; $Try -lt 20; $Try++) {
    $Order = Api 'device_buyer' "/member/order/$Id"
    if ($Order.orderState -eq $State) { return $Order }
    Start-Sleep -Milliseconds 200
  }
  throw "Expected order state $State but got $($Order.orderState)"
}
function Checkout {
  Tap-Text '购物袋'
  Tap-Text '去结算'
  Wait-Text '结算'
  Tap-Text '提交订单'
  Tap-Text '立即支付'
  Wait-Text $PaymentText
}
function Ship {
  Login 'device_merchant'
  Tap-Text '亲友中心 / 商家发货'
  Wait-Text '商家待发货订单'
  Capture 'merchant-order'
  Scroll-Text '确认发货'
}
function Review([string]$Content) {
  Tap-Text '去评价'
  Input-Type 'TextArea' 0 $Content
  Back
  Tap-Text '提交评价'
}
function Capture([string]$Name) {
  Start-Sleep -Milliseconds 700
  $null = Invoke-Hdc @('shell','uitest','screenCap','-p','/data/local/tmp/hdm-regression.png')
  $null = Invoke-Hdc @('file','recv','/data/local/tmp/hdm-regression.png',"$Output/$Name.png")
  $script:Nodes = Read-Nodes
  Copy-Item -LiteralPath "$Output/layout.json" -Destination "$Output/$Name.layout.json"
}
function Save-Result($Data, [string]$Result = 'passed') {
  $Report = [ordered]@{
    startedAt = $StartedAt.ToString('o'); completedAt = (Get-Date).ToString('o')
    durationSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 2)
    target = $Target; mode = $Mode; result = $Result
    counts = @{ passed=$(if ($Result -eq 'passed') { 1 } else { 0 }); failed=$(if ($Result -eq 'failed') { 1 } else { 0 }); skipped=0 }
    packageSha256 = (Get-FileHash "$Root/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app" -Algorithm SHA256).Hash
  }
  foreach ($Entry in $Data.GetEnumerator()) { $Report[$Entry.Key] = $Entry.Value }
  $Report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath "$Output/result.json" -Encoding utf8
}
function Set-PaymentPreset([string]$Outcome, [string]$OrderId = '') {
  $Body = @{preset=@{outcome=$Outcome}}
  if ($OrderId) { $Body.orderId = $OrderId }
  return Invoke-RestMethod "$Base/device-fixture/payment-preset" -Method Post -ContentType 'application/json' -Body ($Body | ConvertTo-Json)
}
function Payment-Proof([string]$OrderId) {
  return Invoke-RestMethod "$Base/device-fixture/orders/$OrderId/payments"
}
function Assert-NoPaymentAction {
  $script:Nodes = Read-Nodes
  if (Find-Text '去支付') { throw 'Confirming order still exposes payment action' }
  if (@($script:Nodes | Where-Object { $_.visible -ne 'false' -and $_.text -match '剩 \d+:\d+ 自动取消|已超时，等待系统取消' }).Count) { throw 'Confirming order still exposes countdown' }
}
function Save-S3Checkpoint([string]$Name, [string[]]$Cases, [string]$OrderId) {
  Capture $Name
  $Proof = Payment-Proof $OrderId
  $Presentation = @(Orders | Where-Object { $_.id -eq $OrderId })[0]
  $Checkpoint = [ordered]@{ name=$Name; cases=$Cases; result='passed'; capturedAt=(Get-Date).ToString('o');
    screenshot="$Name.png"; layout="$Name.layout.json"; order=$Presentation; ledger=$Proof }
  $Checkpoint | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath "$Output/$Name.json" -Encoding utf8
  $script:S3Checks.Add(@{name=$Name; cases=$Cases; result='passed'})
  Write-Output "CHECK S3 $Name [$($Cases -join ',')] passed"
}
function Invoke-S3 {
  $script:S3Checks = [System.Collections.Generic.List[object]]::new()
  Login 'device_buyer'
  Checkout
  $RecoveryId = (Orders)[0].id
  Save-S3Checkpoint 'a1-cashier-unpaid' @('B-33','B-41','B-49') $RecoveryId
  Back
  $Unpaid = Assert-State $RecoveryId 1
  $Inventory = Api 'device_merchant' "/merchant/inventory?skuId=$SkuId"
  if ((Orders).Count -ne 1 -or (Payment-Proof $RecoveryId).payments.Count -ne 0 -or $Inventory.items[0].stock -ne ($InitialStock - 1)) { throw 'Leaving cashier changed order uniqueness, payment or stock' }
  Save-S3Checkpoint 'a1-left-cashier' @('B-33','B-41','B-49') $RecoveryId
  Mine
  Tap-Text '待付款'
  Wait-Text '设备独立测试商品'
  Wait-Text '去支付'
  if ((Orders).Count -ne 1 -or (Assert-State $RecoveryId 1).canPay -ne $true) { throw 'Unpaid restart recovery failed' }
  $Inventory = Api 'device_merchant' "/merchant/inventory?skuId=$SkuId"
  if ($Inventory.items[0].stock -ne ($InitialStock - 1)) { throw 'Unpaid restart released reserved stock' }
  Save-S3Checkpoint 'a2-restarted-unpaid' @('B-33','B-41','B-49') $RecoveryId
  Tap-Text '去支付'
  Wait-Text $PaymentText
  Save-S3Checkpoint 'a2-reopened-cashier' @('B-33','B-41') $RecoveryId
  $null = Set-PaymentPreset 'unknown'
  Tap-Text $PaymentText
  Wait-Text '正在确认付款结果，请勿重复付款'
  $Pending = Payment-Proof $RecoveryId
  if ($Pending.payments.Count -ne 1 -or $Pending.payments[0].state -ne 'pending') { throw 'First confirming payment is not unique' }
  $RecoveryPaymentId = $Pending.payments[0].id
  Save-S3Checkpoint 'a3-confirming-result' @('B-49','B-54') $RecoveryId
  Mine
  Tap-Text '待付款'
  Wait-Text '确认中'
  Assert-NoPaymentAction
  $Confirming = Assert-State $RecoveryId 1
  $Pending = Payment-Proof $RecoveryId
  if ((Orders).Count -ne 1 -or $Confirming.paymentState -ne 'confirming' -or $Confirming.canPay -ne $false -or $Confirming.countdown -ne 0 -or $Pending.payments.Count -ne 1 -or $Pending.payments[0].id -ne $RecoveryPaymentId -or $Pending.payments[0].state -ne 'pending') { throw 'Confirming restart backend proof failed' }
  Save-S3Checkpoint 'a4-restarted-confirming' @('B-49','B-54') $RecoveryId
  Tap-Text '设备独立测试商品'
  Wait-Text ('订单号 ' + $RecoveryId)
  Wait-Text '确认中'
  Assert-NoPaymentAction
  Save-S3Checkpoint 'a4-detail-payment-blocked' @('B-54') $RecoveryId
  $Configured = Set-PaymentPreset 'success' $RecoveryId
  if ($Configured.paymentId -ne $RecoveryPaymentId) { throw 'Recovery preset selected a different payment' }
  Back
  $Deadline = (Get-Date).AddMinutes(6)
  do {
    Tap-Text '全部'
    Tap-Text '待发货'
    $Recovered = @(Orders | Where-Object { $_.id -eq $RecoveryId })[0]
    if ($Recovered.orderState -eq 2) { break }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $Deadline)
  if ($Recovered.orderState -ne 2) { throw 'Application re-entry did not observe reconciled payment within six minutes' }
  Wait-Text '设备独立测试商品'
  Wait-Text '提醒发货'
  $Recovery = Payment-Proof $RecoveryId
  if ($Recovered.paymentState -ne 'paid' -or $Recovery.payments.Count -ne 1 -or $Recovery.payments[0].id -ne $RecoveryPaymentId -or $Recovery.payments[0].state -ne 'succeeded' -or $Recovery.payments[0].amount -ne $AmountCents -or $Recovery.refunds.Count -ne 0) { throw 'Recovered payment success proof failed' }
  Save-S3Checkpoint 'a5-recovered-paid' @('B-54') $RecoveryId
  $null = Api 'device_buyer' '/member/cart' 'Post' @{skuId=$SkuId; count=1}
  Mine
  Checkout
  $CancelId = @(Orders | Where-Object { $_.id -ne $RecoveryId })[0].id
  $null = Set-PaymentPreset 'unknown'
  Tap-Text $PaymentText
  Wait-Text '正在确认付款结果，请勿重复付款'
  Save-S3Checkpoint 'b6-confirming-result' @('B-59') $CancelId
  Tap-Text '返回首页'
  Tap-Text '我的'
  Wait-Text '编辑资料'
  Tap-Text '待付款'
  Wait-Text '确认中'
  Tap-Text '取消订单'
  $AmountText = ([decimal]$AmountCents / 100).ToString('F2', [System.Globalization.CultureInfo]::InvariantCulture)
  Wait-Text ('付款可能已经成功。取消后，如已扣款，¥' + $AmountText + '将原路退回付款账户。确定取消吗？')
  Save-S3Checkpoint 'b6-cancel-warning' @('B-59') $CancelId
  Tap-Text '再等等'
  $StillPending = Assert-State $CancelId 1
  $CancelProof = Payment-Proof $CancelId
  if ($StillPending.paymentState -ne 'confirming' -or $CancelProof.payments.Count -ne 1 -or $CancelProof.payments[0].state -ne 'pending') { throw 'Dismissing cancellation changed pending order' }
  $CancelPaymentId = $CancelProof.payments[0].id
  Save-S3Checkpoint 'b6-dismissed-cancellation' @('B-59') $CancelId
  Tap-Text '取消订单'
  Wait-Text '确认取消订单'
  Tap-Text '确认取消'
  $null = Assert-State $CancelId 6
  Tap-Text '全部'
  Wait-Text '已取消'
  Save-S3Checkpoint 'b6-cancelled' @('B-59') $CancelId
  $Configured = Set-PaymentPreset 'success' $CancelId
  if ($Configured.paymentId -ne $CancelPaymentId -or $Configured.state -ne 'closed') { throw 'Cancelled preset did not select the original closed payment' }
  for ($Try = 0; $Try -lt 15; $Try++) {
    $null = Api 'device_buyer' "/member/order/$CancelId/payments/refresh" 'Post' @{}
    $Cancelled = Payment-Proof $CancelId
    if ($Cancelled.refunds.Count -eq 1 -and $Cancelled.refunds[0].state -eq 'succeeded') { break }
    Start-Sleep -Seconds 1
  }
  $null = Api 'device_buyer' "/member/order/$CancelId/payments/refresh" 'Post' @{}
  $Cancelled = Payment-Proof $CancelId
  if ($Cancelled.order.state -ne 6 -or $Cancelled.payments.Count -ne 1 -or $Cancelled.payments[0].state -ne 'succeeded' -or $Cancelled.payments[0].id -ne $CancelPaymentId -or $Cancelled.refunds.Count -ne 1 -or $Cancelled.refunds[0].payment_id -ne $CancelPaymentId -or $Cancelled.refunds[0].state -ne 'succeeded' -or $Cancelled.refunds[0].amount -ne $AmountCents -or $Cancelled.refunds[0].amount -ne $Cancelled.payments[0].amount -or $Cancelled.refunds[0].reason -ne 'cancelled') { throw 'Cancelled payment refund proof failed' }
  Tap-Text '待付款'
  Tap-Text '全部'
  Wait-Text '已取消 · 已退款'
  $script:Nodes = Read-Nodes
  $RefundLine = @($script:Nodes | Where-Object { $_.visible -ne 'false' -and $_.text -like "¥$AmountText · device_buyer · * · 已退款" })
  if ($RefundLine.Count -ne 1 -or $RefundLine[0].text -match '付款时间待确认') { throw 'Cancelled card refund amount, payer, time or status missing' }
  Wait-Text '●'
  Save-S3Checkpoint 'b7-cancelled-refund-card' @('B-59') $CancelId
  Back
  Wait-Text '编辑资料'
  Wait-Text '●'
  Save-S3Checkpoint 'b7-mine-unread' @('B-59') $CancelId
  Tap-Text '全部订单'
  Tap-Text '已取消 · 已退款'
  Wait-Text ('订单号 ' + $CancelId)
  Wait-Text '已取消 · 已退款'
  Save-S3Checkpoint 'b7-refund-detail' @('B-59') $CancelId
  Back
  Wait-Text '已取消 · 已退款'
  $script:Nodes = Read-Nodes
  if (Find-Text '●') { throw 'Order list unread dot did not clear after viewing detail' }
  Save-S3Checkpoint 'b7-list-read' @('B-59') $CancelId
  Back
  Wait-Text '编辑资料'
  $script:Nodes = Read-Nodes
  if (Find-Text '●') { throw 'Mine unread dot did not clear after returning from detail' }
  $CancelledOrder = @(Orders | Where-Object { $_.id -eq $CancelId })[0]
  if ($CancelledOrder.needsAttention) { throw 'Backend unread notice did not clear' }
  $Inventory = Api 'device_merchant' "/merchant/inventory?skuId=$SkuId"
  $Movements = Api 'device_merchant' "/merchant/inventory/$SkuId/movements"
  $Reserves = @($Movements.items | Where-Object { $_.kind -eq 'reserve' })
  $Releases = @($Movements.items | Where-Object { $_.kind -in @('cancel','expire') })
  if ((Orders).Count -ne 2 -or $Inventory.items[0].stock -ne ($InitialStock - 1) -or $Inventory.items[0].difference -ne 0 -or $Reserves.Count -ne 2 -or $Releases.Count -ne 1 -or $Releases[0].orderId -ne $CancelId -or $Releases[0].delta -ne 1 -or $Releases[0].businessKey -ne "release:${CancelId}:${SkuId}") { throw 'S3 final order count or exactly-once inventory release failed' }
  Save-S3Checkpoint 'b7-mine-read' @('B-59') $CancelId
  Save-Result @{ recovery=$Recovery; cancelled=$Cancelled; stock=$Inventory.items[0].stock; difference=$Inventory.items[0].difference;
    reserves=$Reserves.Count; releases=$Releases.Count; inventoryMovements=$Movements.items; needsAttention=$CancelledOrder.needsAttention;
    checkpoints=$script:S3Checks.ToArray(); deferred=@{case='B-62'; reason='B-62 待第四步 D8 后补入 S3'; date='2026-11-06'} }
  Write-Output "SCRIPT $PSCommandPath RESULT S3 recovery, confirming restart, cancellation, refund, unread notices and exactly-once inventory release passed"
}
$Existing = @(& $Hdc -t $Target fport ls)
$HadOriginal = ($Existing -join "`n") -match 'tcp:3000 tcp:3000\s+\[Reverse\]'
if (($Existing -join "`n") -match 'tcp:3000 tcp:(?!3000\b)') { throw 'Device port 3000 has different forwarding.' }
$FixturePath = Join-Path $PSScriptRoot 'tests/device-trade-server.ts'
$FixtureArguments = @($FixturePath)
if ($PaginationProbe) { $FixtureArguments += '--pagination' }
if ($RelationsProbe) { $FixtureArguments += '--relations' }
$Fixture = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $FixtureArguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$Output/server.stdout.log" -RedirectStandardError "$Output/server.stderr.log"
$Mapped = $false
$OriginalRemoved = $false
try {
  $Ready = $false
  for ($Try = 0; $Try -lt 20; $Try++) {
    if ($Fixture.HasExited) { throw 'Isolated fixture exited before validation.' }
    try {
      $Identity = Invoke-RestMethod "$Base/device-fixture"
      if ($Identity.fixture -eq 'device-trade' -and $Identity.pid -eq $Fixture.Id) { $Ready=$true; break }
    } catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $Ready) { throw 'Isolated backend did not start.' }
  if (-not $Identity.skuId -or $Identity.amountCents -le 0 -or $Identity.initialStock -lt 11) { throw 'Isolated fixture product metadata is invalid.' }
  $SkuId = [string]$Identity.skuId
  $AmountCents = [int]$Identity.amountCents
  $InitialStock = [int]$Identity.initialStock
  $PaymentText = '确认支付 ¥' + ([decimal]$AmountCents / 100).ToString('F2', [System.Globalization.CultureInfo]::InvariantCulture)
  if ($HadOriginal) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3000'); $OriginalRemoved=$true }
  $null = Invoke-Hdc @('rport','tcp:3000','tcp:3103'); $Mapped=$true
  $null = Invoke-Hdc @('install','-r',"$Root/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app")
  if ($S3) { Invoke-S3; return }
  if ($RelationsProbe) {
    Login 'device_buyer'
    Checkout
    Scroll-Text '代付下一页'
    Wait-Text '邀请 probe_00 代付'
    Capture 'payer-page-2'
    Tap-Text '邀请 probe_00 代付'
    Wait-Text '等待亲友 probe_00 代付'
    $Order = (Orders)[0]
    if ($Order.invitedPayerAccount -ne 'probe_00') { throw 'Payer page selection did not reach backend' }
    Write-Output 'CHECK native payer page 2 selection reached backend'
    Mine
    Wait-Text 'device_buyer'
    Tap-Text '亲友中心 · 代付与代收'
    Tap-Text '关系下一页'
    Wait-Text '我的亲友：probe_00'
    Capture 'relations-page-2'
    Tap-Text '解除绑定'
    Wait-Text '我的亲友：probe_10'
    $Relations = Api 'device_buyer' '/member/relations/page?page=1&pageSize=10'
    if ($Relations.counts -ne 10 -or $Relations.pages -ne 1) { throw 'Relation last-page recovery proof failed' }
    Capture 'relations-returned-to-page-1'
    Write-Output 'CHECK native relation page 2 revoke returned to page 1'
    $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3103'); $Mapped=$false
    Tap-Text '刷新'
    Wait-Text '加载失败，请重新登录或重试'
    Wait-Text '我的亲友：probe_10'
    Capture 'relations-offline-preserved'
    $null = Invoke-Hdc @('rport','tcp:3000','tcp:3103'); $Mapped=$true
    Tap-Text '刷新'
    Wait-Text '我的亲友：probe_10'
    for ($Try = 0; $Try -lt 20; $Try++) {
      $script:Nodes = Read-Nodes
      if (-not (Find-Text '加载失败，请重新登录或重试') -and -not (Find-Text '加载中...')) { break }
      Start-Sleep -Milliseconds 300
    }
    if ((Find-Text '加载失败，请重新登录或重试') -or (Find-Text '加载中...')) { throw 'Relation retry did not recover' }
    Mine
    Wait-Text 'device_buyer'
    Tap-Text '亲友中心 · 代付与代收'
    Wait-Text '我的亲友：probe_10'
    Capture 'relations-after-restart'
    Save-Result @{ invitedPayer=$Order.invitedPayerAccount; relations=$Relations.counts; offlinePreserved=$true; restart=$true }
    Write-Output "SCRIPT $PSCommandPath RESULT payer pagination, relation revoke recovery, offline preservation, retry and application restart passed"
    return
  }
  if ($PaginationProbe) {
    Login 'device_friend'
    Tap-Text '亲友中心 · 代付与代收'
    Scroll-Text '亲友下一页'
    Wait-Text '分页商品 01'
    Capture 'family-page-2'
    Tap-Text '亲友上一页'
    Wait-Text '分页商品 11'
    Login 'device_merchant'
    Tap-Text '亲友中心 / 商家发货'
    Scroll-Text '发货下一页'
    Wait-Text '分页商品 11'
    Capture 'merchant-page-2'
    Scroll-Text '确认发货'
    $Shipped = (Orders | Where-Object { $_.skus[0].name -eq '分页商品 11' })[0].id
    $null = Assert-State $Shipped 3
    Wait-Text '分页商品 01'
    $Page = Api 'device_merchant' '/merchant/orders/page?page=1&pageSize=10'
    if ($Page.counts -ne 10 -or $Page.pages -ne 1 -or $Page.items.Count -ne 10) { throw 'Merchant last-page recovery proof failed' }
    Capture 'merchant-returned-to-page-1'
    Save-Result @{ shippedOrderId=$Shipped; merchantOrders=$Page.counts; merchantPages=$Page.pages }
    Write-Output "SCRIPT $PSCommandPath RESULT native family next/previous page, merchant next page and last-item shipment page recovery passed"
    return
  }
  if ($ShipProbe) {
    $Addresses = @(Api 'device_buyer' '/member/address')
    $Order = Api 'device_buyer' '/member/order' 'Post' @{requestKey=[guid]::NewGuid().ToString(); addressId=$Addresses[0].id; goods=@(@{skuId=$SkuId; count=1})}
    $null = Api 'device_buyer' "/member/order/$($Order.id)/mock-pay" 'Post' @{amountCents=$AmountCents}
    Ship
    $null = Assert-State $Order.id 3
    Save-Result @{ shippedOrderId=$Order.id; state=3 }
    Write-Output "SCRIPT $PSCommandPath RESULT native merchant shipment probe passed"
    return
  }
  Login 'device_buyer'
  Checkout
  $SelfOrder = (Orders)[0].id
  Tap-Text $PaymentText
  $null = Assert-State $SelfOrder 2
  Ship
  $null = Assert-State $SelfOrder 3
  Login 'device_buyer'
  Tap-Text '待收货'
  Tap-Text '确认收货'
  $null = Assert-State $SelfOrder 4
  Tap-Text '待评价'
  Review 'device self trade review'
  $Self = Assert-State $SelfOrder 5
  if ($Self.payerAccount -ne 'device_buyer' -or $Self.receivedByAccount -ne 'device_buyer') { throw 'Self trade participant proof failed' }
  Capture 'self-completed'
  Write-Output 'CHECK native self checkout, payment, merchant shipment, receipt and review passed'
  Mine
  Tap-Text '亲友中心 · 代付与代收'
  Input-Type 'TextInput' 0 'device_friend'
  Back
  Tap-Text '发送绑定邀请'
  Wait-Text '待确认'
  Login 'device_friend'
  Tap-Text '亲友中心 · 代付与代收'
  Scroll-Text '同意绑定'
  Wait-Text '已绑定'
  $null = Api 'device_buyer' '/member/cart' 'Post' @{skuId=$SkuId; count=1}
  # 在账号登录触发购物袋加载前准备数据，避免外部夹具修改绕过客户端更新事件。
  Login 'device_buyer'
  Checkout
  Scroll-Text '邀请 device_friend 代付'
  Wait-Text '等待亲友 device_friend 代付'
  $FamilyOrder = (Orders | Where-Object { $_.id -ne $SelfOrder })[0].id
  Login 'device_friend'
  Tap-Text '亲友中心 · 代付与代收'
  Scroll-Text '确认模拟代付'
  Wait-Text '为 device_buyer 模拟代付'
  $DialogAction = $script:Nodes | Where-Object { $_.text -eq '确认模拟代付' -and $_.visible -ne 'false' } | Select-Object -Last 1
  Operate-Node $DialogAction
  $null = Assert-State $FamilyOrder 2
  Wait-Text '待发货'
  if (Find-Text '确认模拟代付') { throw 'Completed payment still shows payment action' }
  Capture 'family-paid'
  Ship
  $null = Assert-State $FamilyOrder 3
  Login 'device_friend'
  Tap-Text '亲友中心 · 代付与代收'
  Scroll-Text '确认代收'
  Tap-Text '已收到，确认'
  $null = Assert-State $FamilyOrder 4
  Wait-Text '已收货'
  if (Find-Text '确认代收') { throw 'Completed receipt still shows receipt action' }
  Capture 'family-received'
  Login 'device_buyer'
  Tap-Text '待评价'
  Review 'device family trade review'
  $Family = Assert-State $FamilyOrder 5
  if ($Family.payerAccount -ne 'device_friend' -or $Family.receivedByAccount -ne 'device_friend') { throw 'Family participant proof failed' }
  $Inventory = Api 'device_merchant' "/merchant/inventory?skuId=$SkuId"
  $Movements = Api 'device_merchant' "/merchant/inventory/$SkuId/movements"
  if ((Orders).Count -ne 2 -or $Inventory.items[0].stock -ne ($InitialStock - 2) -or $Inventory.items[0].difference -ne 0 -or @($Movements.items | Where-Object { $_.kind -eq 'reserve' }).Count -ne 2) { throw 'Final order and inventory proof failed' }
  Capture 'family-completed'
  $Report = [ordered]@{
    startedAt = $StartedAt.ToString('o'); durationSeconds = [math]::Round(((Get-Date) - $StartedAt).TotalSeconds, 2)
    completedAt = (Get-Date).ToString('o'); target = $Target; mode = 'Full'; result = 'passed'
    counts = @{ passed=1; failed=0; skipped=0 }
    packageSha256 = (Get-FileHash "$Root/mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app" -Algorithm SHA256).Hash
    self = @{ id=$Self.id; state=$Self.orderState; payer=$Self.payerAccount; receiver=$Self.receivedByAccount }
    family = @{ id=$Family.id; state=$Family.orderState; payer=$Family.payerAccount; receiver=$Family.receivedByAccount }
    stock = $Inventory.items[0].stock; difference = $Inventory.items[0].difference
    reserves = @($Movements.items | Where-Object { $_.kind -eq 'reserve' }).Count
  }
  $Report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$Output/result.json" -Encoding utf8
  Write-Output "SCRIPT $PSCommandPath RESULT self and family native trade, account switching, two reviewed orders and stock $InitialStock->$($InitialStock - 2) passed"
} catch {
  $Failure = $_
  try { Capture 'failure' } catch { Write-Warning 'Failure screenshot or layout could not be captured' }
  Save-Result @{ error=$Failure.Exception.Message; scriptStackTrace=$Failure.ScriptStackTrace } 'failed'
  throw $Failure
} finally {
  try {
    if ($Mapped) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3103') }
    if ($OriginalRemoved) { $null = Invoke-Hdc @('rport','tcp:3000','tcp:3000') }
  } finally { if (-not $Fixture.HasExited) { Stop-Process -Id $Fixture.Id } }
}
