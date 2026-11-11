$script:ShippingMedia=[System.Collections.Generic.List[string]]::new()
function Add-ReturnShippingProof([string]$Amount='1.00') {
  Product-Control 'after-sale-shipping-amount' $Amount
  Capture 'return-shipping-form'
  $DeviceStart=((Invoke-Hdc @('shell','date','+%Y%m%d_%H%M%S')) -join '').Trim()
  $ScreenshotStart=[datetime]::ParseExact($DeviceStart,'yyyyMMdd_HHmmss',[Globalization.CultureInfo]::InvariantCulture).AddSeconds(-1)
  $null=Invoke-Hdc @('shell','uitest','uiInput','keyEvent','18','17')
  Start-Sleep -Seconds 2
  $DeviceEnd=((Invoke-Hdc @('shell','date','+%Y%m%d_%H%M%S')) -join '').Trim()
  $ScreenshotEnd=[datetime]::ParseExact($DeviceEnd,'yyyyMMdd_HHmmss',[Globalization.CultureInfo]::InvariantCulture).AddSeconds(1)
  @{deviceStart=$DeviceStart;deviceEnd=$DeviceEnd;hostObserved=(Get-Date).ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Output 'shipping-screenshot-clock.json')
  Product-Control 'after-sale-shipping-photo'
  Wait-Text '所有图片'
  $Recent=@()
  for($Attempt=0;$Attempt -lt 15;$Attempt++){
    $script:Nodes=Read-Nodes
    $Recent=@($script:Nodes|Where-Object {
      if($_.id -notmatch '^ThirdSelectAlbumGridBase_GridItem(file://media/Photo/[^?]+/screenshot_([0-9]{8}_[0-9]{6})[.]jpg)[?]'){return $false}
      $Time=[datetime]::ParseExact($Matches[2],'yyyyMMdd_HHmmss',[Globalization.CultureInfo]::InvariantCulture)
      return $Time -ge $ScreenshotStart -and $Time -le $ScreenshotEnd
    })
    if($Recent.Count -eq 1){break}
    Start-Sleep -Milliseconds 400
  }
  if($Recent.Count -ne 1){throw 'Cannot uniquely identify the screenshot just created for this test; no library photo selected'}
  $null=$Recent[0].id -match '^ThirdSelectAlbumGridBase_GridItem(file://media/Photo/[^?]+)[?]'
  $script:ShippingMedia.Add($Matches[1])
  Capture 'return-shipping-picker'
  Operate-Node $Recent[0]
  Tap-Text '完成'
  Wait-Text '更换运单截图'
  Capture '05-return-shipping-selected'
}

function Remove-ReturnShippingMedia {
  foreach($Uri in $script:ShippingMedia){
    $Result=Invoke-Hdc @('shell','mediatool','delete',$Uri)
    if(($Result -join '') -notmatch 'delete success'){throw 'Could not remove the probe-created screenshot'}
    $Name=($Uri -split '/')[-1]
    $Remaining=Invoke-Hdc @('shell','mediatool','query',$Name,'-u')
    if(($Remaining -join '') -notmatch 'find 0 result'){throw 'Probe screenshot remains in the media library'}
  }
  @{created=$script:ShippingMedia.Count;removed=$script:ShippingMedia.Count}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $Output 'media-cleanup.json')
}

function Invoke-PromotionProbe {
  Login 'device_merchant'
  Scroll-Text '满减设置'
  Wait-Text '优惠金额较大时，低价商品可能被抵扣为 0 元'
  Product-Control 'promotion-threshold' '99.00'
  Product-Control 'promotion-discount' '10.00'
  Product-Control 'promotion-save'
  Wait-Text '满减规则已保存'
  Capture '01-promotion-setting'
  Login 'device_buyer'
  Tap-Text '购物袋'
  Tap-Text '去结算'
  Wait-Text '结算'
  $Gap=(9900-$AmountCents)/100
  Wait-Text ('再买 ¥'+$Gap.ToString('F2',[Globalization.CultureInfo]::InvariantCulture)+' 可减 ¥10.00，回首页继续选购')
  Capture '02-promotion-gap'
  Product-Control 'checkout-promotion'
  Wait-Text '首页'
  $null=Api 'device_buyer' ('/member/cart/'+$SkuId) 'Put' @{count=5;selected=$true}
  Tap-Text '购物袋'
  Tap-Text '去结算'
  Wait-Text '满 ¥99.00 减 ¥10.00 −¥10.00'
  Capture '03-promotion-checkout'
  $Payable=$AmountCents*5-1000
  $PaymentText='确认支付 ¥'+([decimal]$Payable/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture)
  Tap-Text '提交订单并付款'
  Wait-Text $PaymentText
  $Order=(Orders)[0].id
  $Snapshot=Api 'device_buyer' ('/member/order/'+$Order)
  if($Snapshot.discountCents -ne 1000 -or $Snapshot.skus[0].discountShareCents -ne 1000 -or [math]::Round($Snapshot.payMoney*100) -ne $Payable){throw 'Promotion order snapshot mismatch'}
  Tap-Text $PaymentText
  $null=Assert-State $Order 2
  Ship
  Login 'device_buyer'
  Tap-Text '待收货'
  Product-Control ('order-apply-after-sale-'+$Order)
  1..3|ForEach-Object{Product-Control 'after-sale-count-minus-0'}
  $Principal=$AmountCents*2-400
  Wait-Text ('预计退款 ¥'+([decimal]$Principal/100).ToString('F2',[Globalization.CultureInfo]::InvariantCulture)+'，退回 device_buyer')
  Wait-Text '已扣除该商品分摊的满减 ¥4.00'
  Capture '04-promotion-partial-refund'
  Product-Control 'after-sale-submit'
  Tap-Text '确认提交'
  $Sale=Wait-AfterSale $Order 'pending'
  if($Sale.amountCents -ne $Principal){throw 'Partial principal does not deduct original discount share'}
  Login 'device_merchant'
  Scroll-Text '售后处理'
  Product-Control ('after-sale-approve-'+$Sale.id)
  Product-Control 'after-sale-receiver' 'Return warehouse'
  Product-Control 'after-sale-contact' '13800138000'
  Product-Control 'after-sale-address' 'Beijing return warehouse 1'
  Product-Control 'after-sale-confirm'
  $null=Wait-AfterSale $Order 'awaiting-return'
  Login 'device_buyer'
  Tap-Text '待评价'
  Tap-Text '设备独立测试商品'
  Product-Control 'after-sale-carrier' 'SF'
  Product-Control 'after-sale-tracking' 'SF202611110001'
  Add-ReturnShippingProof '1.23'
  Product-Control 'after-sale-ship-back'
  $null=Wait-AfterSale $Order 'returned'
  Login 'device_merchant'
  Scroll-Text '售后处理'
  Product-Control 'after-sale-filter-returned'
  Product-Control ('after-sale-inspect-'+$Sale.id)
  Wait-Text '买家实付运费 ¥1.23，默认按买家填写补偿'
  Capture '06-promotion-inspection'
  Product-Control 'after-sale-confirm'
  $Refunded=Wait-AfterSale $Order 'refunded'
  $Proof=Payment-Proof $Order
  $PrincipalRefund=@($Proof.refunds|Where-Object reason -eq 'after-sale')
  $ShippingRefund=@($Proof.refunds|Where-Object reason -eq 'shipping')
  if($Proof.refunds.Count -ne 2 -or $PrincipalRefund.Count -ne 1 -or $ShippingRefund.Count -ne 1 -or $PrincipalRefund[0].amount -ne $Principal -or $ShippingRefund[0].amount -ne 123 -or @($Proof.refunds|Where-Object state -ne 'succeeded').Count){throw 'Expected two successful independent refunds'}
  Login 'device_buyer'
  Tap-Text '待评价'
  Tap-Text '设备独立测试商品'
  Scroll-Text '运费补偿 ¥1.23 · 已退回' -ViewOnly
  Capture '07-promotion-shipping-refunded'
  $Detail=Api 'device_buyer' ('/member/order/'+$Order)
  if($Detail.skus[0].afterSaleRemaining -ne 3 -or $Detail.discountCents -ne 1000){throw 'Remaining goods lost discount or after-sale quantities'}
  Save-Result @{orderId=$Order;order=$Snapshot;afterSale=$Refunded;proof=$Proof;remainingOrder=$Detail;nativeActions=@('promotion-settings','gap-home','discount-checkout','partial-return','shipping-proof','shipping-inspection','two-refunds')}
  Write-Output ('SCRIPT '+$PSCommandPath+' RESULT PromotionProbe passed')
}
