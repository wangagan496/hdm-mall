function Invoke-LogisticsProbe {
  $Address = @(Api 'device_buyer' '/member/address')[0]
  $Order = Api 'device_buyer' '/member/order' 'Post' @{requestKey=[guid]::NewGuid().ToString();expectedAmountCents=$AmountCents;addressId=$Address.id;goods=@(@{skuId=$SkuId;count=1})}
  $Id = $Order.id
  $null = Api 'device_buyer' "/member/order/$Id/mock-pay" 'Post' @{amountCents=$AmountCents}
  Login 'device_merchant'
  Tap-Text '亲友中心 / 商家发货'
  Scroll-Text '确认发货'
  Product-Control 'shipping-carrier'
  Tap-Text '其他'
  Product-Control 'shipping-other-carrier' 'OtherExpress'
  Product-Control 'shipping-tracking-number' 'D1812345678'
  Capture '01-shipping-carrier-and-tracking'
  Product-Control 'shipping-submit'
  $Shipped = Assert-State $Id 3
  if($Shipped.logistics.carrier -ne 'OtherExpress' -or $Shipped.logistics.trackingNo -ne 'D1812345678' -or !$Shipped.shippedAt -or $Shipped.signedAt -or $Shipped.receivedAt){throw 'Shipment registration or separate timestamps failed'}
  $At = [long]$Shipped.shippedAt
  $null = Invoke-RestMethod "$Base/device-fixture/advance" -Method Post -ContentType 'application/json' -Body '{"milliseconds":6000}'
  $Events = @(@{id='collected';state='collected';occurredAt=$At+1000;description='快递已揽收'},@{id='transit';state='transit';occurredAt=$At+2000;description='运输途中'})
  $null = Invoke-RestMethod "$Base/device-fixture/logistics" -Method Post -ContentType 'application/json' -Body (@{orderId=$Id;events=$Events}|ConvertTo-Json -Depth 6)
  Login 'device_buyer'
  Tap-Text '待收货'
  Tap-Text '设备独立测试商品'
  Wait-Text '模拟物流，仅用于本机验收'
  Wait-Text '尚未确认收货'
  Capture '02-buyer-sorted-logistics'
  $Tracking = Api 'device_buyer' "/member/order/$Id/logistics"
  if($Tracking.state -ne 'transit' -or ($Tracking.events.id -join ',') -ne 'collected,transit'){throw 'Normal logistics timeline is incomplete'}
  $NodesNow = Read-Nodes
  $Collected = $NodesNow | Where-Object id -eq 'logistics-event-collected' | Select-Object -First 1
  $Transit = $NodesNow | Where-Object id -eq 'logistics-event-transit' | Select-Object -First 1
  if(!$Collected -or !$Transit){throw 'Buyer timeline events are missing'}
  $CollectedY=[int]([regex]::Matches($Collected.bounds,'\d+')[1].Value)
  $TransitY=[int]([regex]::Matches($Transit.bounds,'\d+')[1].Value)
  if($CollectedY -ge $TransitY){throw 'Buyer timeline is not ordered by event time'}
  $Events = @(@{id='delivering';state='delivering';occurredAt=$At+4000;description='正在派送'},@{id='signed';state='signed';occurredAt=$At+5000;description='快件已签收'})
  $null = Invoke-RestMethod "$Base/device-fixture/logistics" -Method Post -ContentType 'application/json' -Body (@{orderId=$Id;events=$Events}|ConvertTo-Json -Depth 6)
  Product-Control 'order-logistics-refresh'
  Wait-Text '快递显示已签收，确认无误后请确认收货'
  Capture '03-signed-still-awaiting-receipt'
  $Signed = Api 'device_buyer' "/member/order/$Id"
  if($Signed.orderState -ne 3 -or $Signed.signedAt -ne $At+5000 -or $Signed.receivedAt){throw 'Courier signature must not confirm receipt'}
  $Tracking = Api 'device_buyer' "/member/order/$Id/logistics"
  if($Tracking.state -ne 'signed' -or $Tracking.events.Count -ne 4){throw 'Signed logistics timeline is incomplete'}
  $null = Invoke-RestMethod "$Base/device-fixture/advance" -Method Post -ContentType 'application/json' -Body '{"milliseconds":3000}'
  Scroll-Text '确认收货'
  $Received = Assert-State $Id 4
  if($Received.shippedAt -ne $At -or $Received.signedAt -ne $At+5000 -or $Received.receivedAt -le $Received.signedAt){throw 'Shipment, signature and buyer receipt times are not independent'}
  $null = Invoke-Hdc @('shell','uitest','uiInput','swipe','660','850','660','2350','500')
  Capture '04-buyer-confirmed-receipt'
  Save-Result @{orderId=$Id;shipment=$Shipped;signature=$Signed;receipt=$Received;logistics=$Tracking;checks=@('carrier-other','tracking-input','sorted-native-timeline','normal-delivery','signed-hint','signature-not-receipt','native-confirmation','three-independent-timestamps')}
  Write-Output "SCRIPT $PSCommandPath RESULT LogisticsProbe passed"
}

function Invoke-ReconcileProbe {
  $Prepared = Invoke-RestMethod "$Base/device-fixture/reconciliation" -Method Post -ContentType 'application/json' -Body '{}'
  $Date = $Prepared.date
  Login 'device_merchant'
  Product-Control 'merchant-reconciliation-entry'
  Product-Control 'reconciliation-date' $Date
  Product-Control 'reconciliation-run'
  Wait-Text '差异 4 条 · 待处理 4 条'
  Capture '01-four-reconciliation-differences'
  $Report = Api 'device_merchant' "/merchant/reconciliation?date=$Date"
  if(($Report.differences.category | Sort-Object) -join ',' -ne 'amount,channel-only,local-only,state'){throw 'Four reconciliation categories missing'}
  $Linked = $Report.differences | Where-Object { $_.orderId } | Select-Object -First 1
  if(!$Linked -or !$Linked.buyerAccount -or !$Linked.orderCreatedAt -or !$Linked.orderItems.Count){throw 'Reconciliation order display fields missing'}
  $Summary = Read-Nodes | Where-Object id -eq ('reconciliation-order-summary-'+$Linked.id) | Select-Object -First 1
  if(!$Summary -or $Summary.text -notlike "*$($Linked.buyerAccount)*" -or $Summary.text -notlike "*$($Linked.orderItems[0].name)*" -or $Summary.text -notmatch '× 1' -or $Summary.text -match '业务编号'){throw 'Reconciliation card did not show buyer and order items'}
  Capture '02a-readable-order-summary'
  Product-Control ('reconciliation-order-'+$Linked.id)
  Wait-Text '商家订单详情'
  Wait-Text ('实付 ¥' + ($AmountCents / 100).ToString('F2', [Globalization.CultureInfo]::InvariantCulture))
  Capture '02b-reconciliation-order-detail'
  Back
  Wait-Text '差异 4 条 · 待处理 4 条'
  Scroll-Text '系统内无对应订单' -ViewOnly
  Capture '02c-channel-only-no-order'
  $External = $Report.differences | Where-Object category -eq 'channel-only' | Select-Object -First 1
  if($External.orderId -or @(Read-Nodes | Where-Object id -eq ('reconciliation-order-'+$External.id)).Count){throw 'Channel-only card must not link an unrelated order'}
  Scroll-Text $Report.differences[0].description -ViewOnly -Reverse
  foreach($Difference in $Report.differences){Scroll-Text $Difference.description -ViewOnly}
  Capture '02-reconciliation-readable-differences'
  Product-Control 'reconciliation-run'
  Wait-Text '差异 4 条 · 待处理 4 条'
  $Repeated = Api 'device_merchant' "/merchant/reconciliation?date=$Date"
  if(($Repeated.differences.id -join ',') -ne ($Report.differences.id -join ',')){throw 'Repeated reconciliation created new differences'}
  # Reloading the page returns the difference list to its first entry.
  Mine
  Product-Control 'merchant-reconciliation-entry'
  Product-Control 'reconciliation-date' $Date
  Product-Control 'reconciliation-query'
  Wait-Text '差异 4 条 · 待处理 4 条'
  $Difference = $Report.differences[0]
  Product-Control ('reconciliation-resolve-'+$Difference.id)
  Product-Control 'reconciliation-reason' 'bad'
  Product-Control 'reconciliation-save'
  Wait-Text '请填写5到200字的处理原因'
  $Invalid = Api 'device_merchant' "/merchant/reconciliation?date=$Date"
  if($Invalid.pendingCount -ne 4){throw 'Short resolution reason changed the report'}
  Product-Control 'reconciliation-reason' 'Verified channel difference'
  Product-Control 'reconciliation-save'
  Wait-Text '差异 4 条 · 待处理 3 条'
  Wait-Text '已处理'
  Capture '03-reconciliation-resolved-with-reason'
  Product-Control 'reconciliation-run'
  Wait-Text '差异 4 条 · 待处理 3 条'
  $Final = Api 'device_merchant' "/merchant/reconciliation?date=$Date"
  $Resolved = $Final.differences | Where-Object id -eq $Difference.id
  if($Resolved.state -ne 'resolved' -or $Resolved.reason -ne 'Verified channel difference' -or $Resolved.handlerAccount -ne 'device_merchant' -or !$Resolved.handledAt){throw 'Resolution reason or actor/time missing'}
  $Audit=Api 'device_merchant' '/merchant/audit-log?action=reconciliation.resolve'
  if($Audit.counts -ne 1 -or $Audit.items[0].actorAccount -ne 'device_merchant'){throw 'Resolution audit missing or duplicated'}
  Save-Result @{date=$Date;initial=$Report;final=$Final;audit=$Audit;checks=@('native-mine-entry','date-entry','four-categories','readable-buyer-order-items','native-order-detail','channel-only-no-order','rerun-idempotent','reason-required','native-resolve','resolved-state-retained','actor-time-audit')}
  Write-Output "SCRIPT $PSCommandPath RESULT ReconcileProbe passed"
}
