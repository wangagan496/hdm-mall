function Rapid-TradeTap([string]$Text, [string]$Name, [switch]$Last) {
  Wait-Text $Text
  $Candidates = @($script:Nodes | Where-Object { ($_.text -eq $Text -or $_.description -eq $Text) -and $_.visible -ne 'false' })
  $Node = if ($Last) { $Candidates[-1] } else { $Candidates[0] }
  if ($Node.enabled -eq 'false') { throw "Rapid tap target is disabled: $Text" }
  $Bounds = [regex]::Matches($Node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
  $X = [int](($Bounds[0] + $Bounds[2]) / 2)
  $Y = [int](($Bounds[1] + $Bounds[3]) / 2)
  $Command = 'for n in 1 2 3; do echo TAP-$n-$(date +%s%3N); uitest uiInput click ' + $X + ' ' + $Y + ' > /data/local/tmp/hdm-trade-tap-$n.txt 2>&1 & sleep 0.05; done; wait; for n in 1 2 3; do echo RESULT-$n; cat /data/local/tmp/hdm-trade-tap-$n.txt; done'
  $Raw = (Invoke-Hdc @('shell',$Command)) -join "`n"
  $Times = @([regex]::Matches($Raw, 'TAP-([123])-([0-9]{13})') | ForEach-Object { [long]$_.Groups[2].Value })
  $Intervals = if ($Times.Count -eq 3) { @($Times[1]-$Times[0];$Times[2]-$Times[1]) } else { @() }
  $Proof = @{name=$Name;text=$Text;count=3;intervalMs=$Intervals;timestampMeaning='device-side uitest command launch';raw=$Raw;injectionIntervalVerified=$false}
  $Proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$Output/$Name-rapid-taps.json" -Encoding utf8
  $script:RapidTaps.Add($Proof)
  $Errors = $Raw -replace 'No Error', ''
  if ($Times.Count -ne 3 -or @($Intervals | Where-Object { $_ -gt 100 -or $_ -lt 0 }).Count -or $Errors -match '(?i)error|fail|exception') { throw "B-87 rapid tap execution failed: $Name" }
}

function Save-TradeNetworkCheckpoint([string]$Name, [string[]]$Cases, [string]$OrderId, [string]$Visible, [string]$Result = 'passed') {
  Save-BuyerCheckpoint $Name $Cases $OrderId | Out-Null
  if ($Result -ne 'passed') {
    $Checkpoint = Get-Content -LiteralPath "$Output/$Name.json" -Raw | ConvertFrom-Json
    $Checkpoint.result = $Result
    $Checkpoint | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath "$Output/$Name.json" -Encoding utf8
    $script:BuyerChecks[$script:BuyerChecks.Count - 1].result = $Result
  }
  $Audit = Api 'device_merchant' '/merchant/audit-log?pageSize=100'
  @{name=$Name;cases=$Cases;result=$Result;userVisible=$Visible;audit=$Audit;ledger=(Payment-Proof $OrderId)} |
    ConvertTo-Json -Depth 18 | Set-Content -LiteralPath "$Output/$Name-user-proof.json" -Encoding utf8
  Write-Output "CHECK $Mode $Name [$($Cases -join ',')] $Result"
}

function Restore-TradeNetwork {
  for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    $Mappings = (Invoke-Hdc @('fport','ls')) -join [Environment]::NewLine
    if ($Mappings -match 'tcp:3000 tcp:3103') { break }
    $script:Mapped = $false
    Start-Sleep -Milliseconds 500
    Restore-TestNetwork
    Start-Sleep -Milliseconds 500
  }
  $Mappings = (Invoke-Hdc @('fport','ls')) -join [Environment]::NewLine
  $Mappings | Add-Content -LiteralPath "$Output/network-restores.txt"
  if ($Mappings -notmatch 'tcp:3000 tcp:3103') { throw 'Restored test network mapping is absent' }
}

function Assert-TradeActionCount([string]$OrderId, [string]$Action, [int]$Count) {
  $Proof = Payment-Proof $OrderId
  if (@($Proof.cancelActions | Where-Object action -eq $Action).Count -ne $Count) { throw "Expected $Count $Action receipt(s) for $OrderId" }
  $ActionKeys = @($Proof.cancelActions | ForEach-Object request_key)
  if (@($ActionKeys | Select-Object -Unique).Count -ne $ActionKeys.Count) { throw 'Duplicate cancellation request keys' }
  return $Proof
}

function Complete-BuyerRecovery([string]$Name, [string]$Case, [string]$OrderId, [string]$ActionText) {
  Wait-TradeNetworkKnown $ActionText ($Name+'-no-auto-recovery') $Case $OrderId
  $Action = Find-Text $ActionText
  $Usable = $Action -and $Action.enabled -ne 'false' -and -not (Find-Text '加载失败，点击重试')
  $Result = if ($Usable) { 'passed' } else { 'failed' }
  $Visible = if ($Usable) { '自动核对后显示正确状态且按钮可用' } else { '自动核对后状态正确，但操作按钮仍禁用，页面残留加载失败提示' }
  Save-TradeNetworkCheckpoint $Name @($Case) $OrderId $Visible $Result
  $script:TradeScenarios.Add(@{case=$Case;result=$Result;userVisible=$Visible})
  if (-not $Usable) {
    Tap-Text '加载失败，点击重试'
    Wait-Text $ActionText
    @{case=$Case;action='explicit list reload after capturing failure; not counted as automatic recovery'} |
      ConvertTo-Json | Set-Content -LiteralPath "$Output/$Name-diagnostic-reload.json" -Encoding utf8
  }
}

function Wait-TradeNetworkKnown([string]$Expected, [string]$Name, [string]$Case, [string]$OrderId) {
  for ($Attempt = 0; $Attempt -lt 45; $Attempt++) {
    $script:Nodes = Read-Nodes
    $Unknown = (Find-Text '操作结果待确认，请重新查询') -or (Find-Text '正在确认取消结果') -or (Find-Text '正在核对取消结果')
    if (-not $Unknown -and (Find-Text $Expected)) { return }
    Start-Sleep -Milliseconds 500
  }
  Save-TradeNetworkCheckpoint $Name @($Case) $OrderId '恢复网络后仍未自动核对，保留当前实际画面' 'failed'
  throw "$Case restored network did not automatically reconcile without a user retry"
}

function Assert-TradeNetworkPending([string]$Name, [string]$Case, [string]$OrderId, [string]$ActionText) {
  $PendingText = if ($Case -in @('B-85','B-86')) { '正在核对取消结果' } else { '正在确认取消结果' }
  Wait-Text $PendingText
  foreach ($Text in @('取消操作已确认','取消成功','撤回成功','操作失败')) {
    if (Find-Text $Text) { throw "$Case unknown result displayed a definitive outcome: $Text" }
  }
  $Action = Find-Text $ActionText
  if ($Action -and $Action.enabled -ne 'false') { throw "$Case pending action remains enabled" }
  Save-TradeNetworkCheckpoint $Name @($Case) $OrderId '请求已被接受但响应丢失；显示待确认，交易按钮不可重复提交'
}

function New-TradeNetworkOrder([string]$Name) {
  if ((Orders).Count -gt 0) { $null = Api 'device_buyer' '/member/cart' 'Post' @{skuId=$SkuId;count=1;requestKey=[guid]::NewGuid().ToString()} }
  Login 'device_buyer' | Out-Host
  Tap-Text '购物袋'
  Tap-Text '去结算'
  Wait-Text '结算'
  $Before = @(Orders).Count
  Rapid-TradeTap '提交订单并付款' ($Name+'-order')
  Wait-Text $PaymentText
  $Created = @(Orders)
  if ($Created.Count -ne $Before + 1) { throw 'B-87 rapid submit created an unexpected order count' }
  $OrderId = $Created[0].id
  $null = Set-PaymentPreset 'success'
  Rapid-TradeTap $PaymentText ($Name+'-payment')
  $null = Wait-OrderState $OrderId 2
  $Proof = Payment-Proof $OrderId
  if ($Proof.payments.Count -ne 1 -or $Proof.payments[0].state -ne 'succeeded') { throw 'B-87 rapid payment created multiple payment rows' }
  $Moves = Api 'device_merchant' "/merchant/inventory/$SkuId/movements"
  if (@($Moves.items | Where-Object { $_.orderId -eq $OrderId -and $_.kind -eq 'reserve' }).Count -ne 1) { throw 'B-87 rapid order reserved stock more than once' }
  Mine
  Tap-Text '待发货'
  Save-TradeNetworkCheckpoint ($Name+'-paid-once') @('B-87') $OrderId '连续点击提交与付款后仅生成一笔订单和支付，显示待发货' | Out-Host
  return $OrderId
}

function Invoke-TradeNetworkProbe {
  $script:BuyerChecks = [System.Collections.Generic.List[object]]::new()
  $script:RapidTaps = [System.Collections.Generic.List[object]]::new()
  $script:TradeScenarios = [System.Collections.Generic.List[object]]::new()
  $OrderId = New-TradeNetworkOrder '01'
  $null = Response-Barrier 'cancel-request' $true
  Tap-Text '取消订单'
  Capture '02-B-83-buyer-confirmation-no-reason-field'
  Rapid-TradeTap '确定申请' '02-cancel-request'
  Disconnect-AcceptedResponse 'cancel-request'
  Copy-Item -LiteralPath "$Output/cancel-request-accepted-before-disconnect.json" -Destination "$Output/B-83-accepted-before-disconnect.json"
  Assert-TradeNetworkPending '03-B-83-request-offline' 'B-83' $OrderId '取消订单'
  $Proof = Assert-TradeActionCount $OrderId 'request' 1
  if ($Proof.cancelRequests.Count -ne 1 -or $Proof.refunds.Count -ne 0) { throw 'B-83 request applied more than once' }
  Restore-TradeNetwork
  Complete-BuyerRecovery '04-B-83-request-recovered' 'B-83' $OrderId '撤回申请'

  $null = Response-Barrier 'cancel-withdraw' $true
  Rapid-TradeTap '撤回申请' '05-cancel-withdraw'
  Disconnect-AcceptedResponse 'cancel-withdraw'
  Copy-Item -LiteralPath "$Output/cancel-withdraw-accepted-before-disconnect.json" -Destination "$Output/B-84-accepted-before-disconnect.json"
  Assert-TradeNetworkPending '05-B-84-withdraw-offline' 'B-84' $OrderId '撤回申请'
  $null = Assert-TradeActionCount $OrderId 'withdraw' 1
  Restore-TradeNetwork
  Complete-BuyerRecovery '06-B-84-withdraw-recovered' 'B-84' $OrderId '取消订单'

  $null = Response-Barrier 'cancel-request' $true
  Tap-Text '取消订单'
  Tap-Text '确定申请'
  Disconnect-AcceptedResponse 'cancel-request'
  Copy-Item -LiteralPath "$Output/cancel-request-accepted-before-disconnect.json" -Destination "$Output/B-88-accepted-before-disconnect.json"
  Assert-TradeNetworkPending '07-B-88-before-force-stop' 'B-88' $OrderId '取消订单'
  $BeforeRestart = Payment-Proof $OrderId
  $null = Invoke-Hdc @('shell','aa','force-stop','com.hdm.mall')
  Restore-TradeNetwork
  $null = Invoke-Hdc @('shell','aa','start','-a','PhoneAbility','-b','com.hdm.mall')
  Mine
  Tap-Text '待发货'
  Wait-TradeNetworkKnown '撤回申请' '08-B-88-restart-not-recovered' 'B-88' $OrderId
  $AfterRestart = Payment-Proof $OrderId
  if ($AfterRestart.cancelRequests.Count -ne $BeforeRestart.cancelRequests.Count -or $AfterRestart.cancelActions.Count -ne $BeforeRestart.cancelActions.Count) { throw 'B-88 restart repeated the pending action' }
  Save-TradeNetworkCheckpoint '08-B-88-restarted-recovered' @('B-88') $OrderId '结束应用再启动，进入订单后显示真实审核状态，无重复提交'
  $script:TradeScenarios.Add(@{case='B-88';result='passed';navigation='restart then open pending-shipment orders'})

  foreach ($Decision in @('approve','reject-and-ship')) {
    if ($Decision -eq 'reject-and-ship') {
      $OrderId = New-TradeNetworkOrder '12'
      Tap-Text '取消订单'
      Tap-Text '确定申请'
      Wait-Text '撤回申请'
    }
    $Case = if ($Decision -eq 'approve') { 'B-85' } else { 'B-86' }
    Login 'device_merchant'
    Tap-Text '亲友中心 / 商家发货'
    Scroll-Text '处理取消申请'
    $null = Response-Barrier 'cancel-resolve' $true
    if ($Decision -eq 'approve') {
      Tap-Text '同意取消'
      Wait-Text '同意取消订单'
      Rapid-TradeTap '同意取消' ($Case+'-merchant-resolve') -Last
    } else {
      Input-Type 'TextArea' 0 'Already packed for shipment'
      Back
      Save-TradeNetworkCheckpoint ($Case+'-entered-reason') @($Case) $OrderId '商家填写拒绝原因，提交前可见'
      Rapid-TradeTap '拒绝并发货' ($Case+'-merchant-resolve')
    }
    Disconnect-AcceptedResponse 'cancel-resolve'
    Copy-Item -LiteralPath "$Output/cancel-resolve-accepted-before-disconnect.json" -Destination "$Output/$Case-accepted-before-disconnect.json"
    Assert-TradeNetworkPending ($Case+'-merchant-offline') $Case $OrderId $(if ($Decision -eq 'approve') { '同意取消' } else { '拒绝并发货' })
    $ReasonVisible = $Decision -eq 'approve' -or [bool](Find-Text 'Already packed for shipment')
    $Proof = Assert-TradeActionCount $OrderId $Decision 1
    if ($Decision -eq 'approve') {
      if ($Proof.refunds.Count -ne 1 -or $Proof.refunds[0].state -ne 'succeeded' -or $Proof.refunds[0].attempts -ne 1) { throw 'B-85 approval refund is not exactly once' }
      $Stock = Api 'device_merchant' "/merchant/inventory?skuId=$SkuId"
      Assert-CancelInventory $OrderId 1 $Stock.items[0].stock
    } else {
      if ($Proof.refunds.Count -ne 0 -or $Proof.order.state -ne 3) { throw 'B-86 rejection produced wrong shipping/refund state' }
      Assert-CancelInventory $OrderId 0 ($InitialStock - 1)
    }
    $Audit = Api 'device_merchant' '/merchant/audit-log?pageSize=100'
    $AuditAction = if ($Decision -eq 'approve') { 'cancel.approve' } else { 'order.reject_and_ship' }
    if (@($Audit.items | Where-Object action -eq $AuditAction).Count -ne 1) { throw "$Case duplicate merchant audit" }
    Restore-TradeNetwork
    $Recovered = $true
    try { Wait-TradeNetworkKnown '商家待发货订单' ($Case+'-no-auto-recovery') $Case $OrderId } catch {
      $Recovered = $false
      $script:TradeScenarios.Add(@{case=$Case;result='failed';reason=$_.Exception.Message;reasonVisible=$ReasonVisible;ledger=$Proof})
    }
    if ($Recovered) { $script:TradeScenarios.Add(@{case=$Case;result=$(if($ReasonVisible){'passed'}else{'failed'});reasonVisible=$ReasonVisible;ledger=$Proof}) }
    $MerchantResult = if ($Recovered -and $ReasonVisible) { 'passed' } else { 'failed' }
    Save-TradeNetworkCheckpoint ($Case+'-merchant-restored-actual') @($Case,'B-87') $OrderId '恢复网络后的实际状态；是否自动核对以场景结果为准' $MerchantResult
    Login 'device_buyer'
    Tap-Text $(if ($Decision -eq 'approve') { '全部订单' } else { '待收货' })
    Wait-Text $(if ($Decision -eq 'approve') { '已取消 · 已退款' } else { '商家拒绝取消申请：Already packed for shipment。如有问题请联系客服' })
    Save-TradeNetworkCheckpoint ($Case+'-buyer-final') @($Case) $OrderId '买家重新进入后看到服务端最终取消或拒绝发货结果'
  }
  $script:TradeScenarios.Add(@{case='B-87';result='blocked';reason='Command launch intervals recorded; actual input-event spacing requires platform instrumentation';rapidTaps=$script:RapidTaps.ToArray()})
  $Failures = @($script:TradeScenarios | Where-Object result -ne 'passed')
  $Result = if ($Failures.Count) { 'failed' } else { 'passed' }
  Save-Result @{checkpoints=$script:BuyerChecks.ToArray();scenarios=$script:TradeScenarios.ToArray();rapidTaps=$script:RapidTaps.ToArray()} $Result
  if ($Failures.Count) { throw 'TradeNetworkProbe has failed or unverified scenarios; see scenario-results.json' }
}

function Invoke-TradeNetworkRun {
  $LockPath = Join-Path $Root '_device_acceptance/device.lock'
  $Owner = if (Test-Path -LiteralPath $LockPath) { (Get-Content -LiteralPath $LockPath -Raw).Trim() } else { '' }
  if (-not $Owner) { throw 'TradeNetworkProbe requires a held device lock (_device_acceptance/device.lock) before install or run' }
  $Existing = @(& $Hdc -t $Target fport ls | Where-Object { $_ -like "$Target *" })
  $Existing | Set-Content -LiteralPath "$Output/ports-before.txt"
  if (Get-NetTCPConnection -LocalPort 3103 -State Listen -ErrorAction SilentlyContinue) { throw 'Fixture port 3103 is already in use' }
  if (($Existing -join "`n") -match 'tcp:3000 tcp:(?!3000\b)') { throw 'Device port 3000 has different forwarding' }
  $HadOriginal = ($Existing -join "`n") -match 'tcp:3000 tcp:3000\s+\[Reverse\]'
  $OriginalRemoved = $false
  $script:Mapped = $false
  $Fixture = $null
  $Identity = $null
  try {
    $FixturePath = Join-Path $Root 'server/test/device-trade-network-server.ts'
    $Fixture = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @($FixturePath) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput "$Output/server.stdout.log" -RedirectStandardError "$Output/server.stderr.log"
    for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
      if ($Fixture.HasExited) { throw 'Isolated trade-network fixture exited' }
      try { $Identity = Invoke-RestMethod "$Base/device-fixture"; if($Identity.fixture -eq 'device-trade-network' -and $Identity.pid -eq $Fixture.Id){break} } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $Identity -or $Identity.pid -ne $Fixture.Id) { throw 'Trade-network fixture did not become ready' }
    $script:Password = (Invoke-RestMethod "$Base/device-fixture/form/device_buyer").result.password
    $script:SkuId = [string]$Identity.skuId
    $script:AmountCents = [int]$Identity.amountCents
    $script:InitialStock = [int]$Identity.initialStock
    $script:PaymentText = '确认支付 ¥' + ([decimal]$AmountCents / 100).ToString('F2', [Globalization.CultureInfo]::InvariantCulture)
    if ($HadOriginal) { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3000'); $OriginalRemoved = $true }
    Restore-TradeNetwork
    if ((Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash -ne $PackageSha256) { throw 'Package changed before trade-network installation' }
    $null = Invoke-Hdc @('install','-r',$PackagePath)
    Invoke-TradeNetworkProbe
  } catch {
    $Failure = $_
    try { Capture 'failure' } catch { }
    $Data = @{error=$Failure.Exception.Message;stack=$Failure.ScriptStackTrace}
    if ($null -ne $script:BuyerChecks) { $Data.checkpoints = $script:BuyerChecks.ToArray() }
    if ($null -ne $script:TradeScenarios) { $Data.scenarios = $script:TradeScenarios.ToArray() }
    try { $Data.orders = @(Orders); $Data.ledgers = @($Data.orders | ForEach-Object { Payment-Proof $_.id }) } catch { }
    Save-Result $Data 'failed'
    throw $Failure
  } finally {
    if ($null -ne $script:TradeScenarios) { ConvertTo-Json -InputObject $script:TradeScenarios.ToArray() -Depth 20 | Set-Content -LiteralPath "$Output/scenario-results.json" -Encoding utf8 }
    try {
      try {
        if ($script:Mapped) {
          $ActualMappings = (Invoke-Hdc @('fport','ls')) -join [Environment]::NewLine
          if ($ActualMappings -match 'tcp:3000 tcp:3103') { $null = Invoke-Hdc @('fport','rm','tcp:3000','tcp:3103') }
          $script:Mapped = $false
        }
      }
      finally { if ($OriginalRemoved) { $null = Invoke-Hdc @('rport','tcp:3000','tcp:3000') } }
    } finally {
      if ($Fixture -and -not $Fixture.HasExited) { Stop-Process -Id $Fixture.Id; $Fixture.WaitForExit() }
      $UploadsRemoved = $true
      if ($Identity.uploadsPath) {
        $Uploads = [IO.Path]::GetFullPath($Identity.uploadsPath)
        $Parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
        if ([IO.Path]::GetDirectoryName($Uploads) -ne $Parent -or [IO.Path]::GetFileName($Uploads) -notlike ('hdm-device-trade-uploads-'+$Fixture.Id+'-*')) { throw 'Unexpected fixture uploads cleanup path' }
        if (Test-Path -LiteralPath $Uploads) { Remove-Item -LiteralPath $Uploads -Recurse -Force }
        $UploadsRemoved = -not (Test-Path -LiteralPath $Uploads)
      }
      $After = @(& $Hdc -t $Target fport ls | Where-Object { $_ -like "$Target *" })
      $After | Set-Content -LiteralPath "$Output/ports-after.txt"
      $Cleanup = @{portsRestored=(($Existing -join "`n") -eq ($After -join "`n"));fixtureExited=($null -eq $Fixture -or $Fixture.HasExited);port3103Free=(-not (Get-NetTCPConnection -LocalPort 3103 -State Listen -ErrorAction SilentlyContinue));uploadsRemoved=$UploadsRemoved;mediaCreated=0;mediaCleanupVerified=$true}
      $Cleanup | ConvertTo-Json | Set-Content -LiteralPath "$Output/cleanup.json" -Encoding utf8
      @{created=@();deleted=@();remaining=@();verified=$true;reason='uitest screenCap writes only /data/local/tmp; no gallery media created'} | ConvertTo-Json | Set-Content -LiteralPath "$Output/media-cleanup.json" -Encoding utf8
      if (@($Cleanup.GetEnumerator() | Where-Object { $_.Value -is [bool] -and -not $_.Value }).Count) { throw 'Trade network cleanup failed' }
    }
  }
}

if ($TradeNetworkProbe) { Invoke-TradeNetworkRun }
