function Add-ServicePhoto {
  $StartText = ((Invoke-Hdc @('shell','date','+%Y%m%d_%H%M%S')) -join '').Trim()
  $Start = [datetime]::ParseExact($StartText,'yyyyMMdd_HHmmss',[Globalization.CultureInfo]::InvariantCulture).AddSeconds(-1)
  $null = Invoke-Hdc @('shell','uitest','uiInput','keyEvent','18','17')
  Start-Sleep -Seconds 2
  $EndText = ((Invoke-Hdc @('shell','date','+%Y%m%d_%H%M%S')) -join '').Trim()
  $End = [datetime]::ParseExact($EndText,'yyyyMMdd_HHmmss',[Globalization.CultureInfo]::InvariantCulture).AddSeconds(1)
  Product-Control 'service-photo'
  Wait-Text '所有图片'
  $Recent = @()
  for ($Attempt=0; $Attempt -lt 15; $Attempt++) {
    $Recent = @(Read-Nodes | Where-Object {
      if ($_.id -notmatch '^ThirdSelectAlbumGridBase_GridItem(file://media/Photo/[^?]+/screenshot_([0-9]{8}_[0-9]{6})[.]jpg)[?]') { return $false }
      $Time = [datetime]::ParseExact($Matches[2],'yyyyMMdd_HHmmss',[Globalization.CultureInfo]::InvariantCulture)
      return $Time -ge $Start -and $Time -le $End
    })
    if ($Recent.Count -eq 1) { break }
    Start-Sleep -Milliseconds 400
  }
  if ($Recent.Count -ne 1) { throw 'Could not uniquely identify the screenshot created for ServiceProbe' }
  $null = $Recent[0].id -match '^ThirdSelectAlbumGridBase_GridItem(file://media/Photo/[^?]+)[?]'
  $script:ShippingMedia.Add($Matches[1])
  Operate-Node $Recent[0]
  Tap-Text '完成'
  Wait-Text '移除照片 1'
}

function Invoke-ServiceProbe {
  Login 'device_buyer'
  Tap-Text '购物袋'
  Tap-Text '去结算'
  Wait-Text '结算'
  Product-Control 'invoice-enabled'
  Product-Control 'invoice-company'
  Product-Control 'invoice-title' 'Device Company'
  Product-Control 'invoice-tax-id' '91310000123456789A'
  Product-Control 'invoice-email' 'service.invoice@example.test'
  Capture '01-checkout-invoice'
  Tap-Text '提交订单并付款'
  Wait-Text $PaymentText
  $Order = (Orders)[0].id
  $Registered = Api 'device_buyer' ('/member/order/' + $Order)
  if ($Registered.invoice.status -ne 'requested' -or $Registered.invoice.titleType -ne 'company') { throw 'Native checkout did not register invoice' }
  Tap-Text $PaymentText
  $null = Assert-State $Order 2
  Login 'device_merchant'
  Scroll-Text '操作记录'
  Product-Control 'audit-action-invoice.request'
  Wait-Text '商家订单详情'
  Product-Control 'invoice-number' 'SERVICE-20261111'
  Product-Control 'invoice-issue'
  Wait-Text '已标记开票，买家可以查看'
  Capture '02-merchant-invoice-issued'
  $Issued = Api 'device_buyer' ('/member/order/' + $Order)
  if ($Issued.invoice.status -ne 'issued' -or $Issued.invoice.number -ne 'SERVICE-20261111') { throw 'Buyer cannot see issued invoice' }
  Login 'device_buyer'
  Tap-Text '待发货'
  Tap-Text '设备独立测试商品'
  Product-Control 'order-service'
  $Linked = Read-Nodes | Where-Object { $_.id -eq 'service-linked-order' } | Select-Object -First 1
  if (-not $Linked -or $Linked.text -notlike '关联订单：设备独立测试商品 · * 下单') { throw ('Linked order should show product and order time, got: ' + $Linked.text) }
  Product-Control 'service-content' 'Please check the invoice and this order'
  Add-ServicePhoto
  Product-Control 'service-send'
  Wait-Text '已发送'
  Capture '03-buyer-service-message'
  $History = Api 'device_buyer' '/member/service/messages'
  if ($History.items.Count -ne 1 -or $History.items[0].orderId -ne $Order -or $History.items[0].images.Count -ne 1) { throw 'Buyer message, order or private photo missing' }
  $BuyerId = $History.items[0].buyerId
  $Image = $History.items[0].images[0]
  $OtherDenied = $false
  try { $null = Api 'device_friend' $Image } catch { $OtherDenied = [int]$_.Exception.Response.StatusCode -eq 403 }
  if (-not $OtherDenied) { throw 'Other buyer must not see private service photo' }
  Login 'device_merchant'
  Product-Control 'merchant-service-entry'
  Product-Control ('service-thread-' + $BuyerId)
  Wait-Text 'Please check the invoice and this order'
  Product-Control 'service-content' 'Invoice is issued and we will follow up'
  Product-Control 'service-send'
  Wait-Text '已发送'
  Capture '04-merchant-service-reply'
  if ((Api 'device_buyer' '/member/service/unread').count -ne 1) { throw 'Reply must increase unread count' }
  Login 'device_buyer'
  Wait-Text '● 有新回复'
  Capture '05-buyer-service-unread'
  Tap-Text '我的客服'
  Wait-Text 'Invoice is issued and we will follow up'
  Capture '06-buyer-service-reply'
  if ((Api 'device_buyer' '/member/service/unread').count -ne 0) { throw 'Visible reply must be marked read' }
  Ship
  $null = Assert-State $Order 3
  Login 'device_buyer'
  Tap-Text '待收货'
  Tap-Text '确认收货'
  $null = Assert-State $Order 4
  Tap-Text '待评价'
  Review 'Original service review for moderation'
  $null = Assert-State $Order 5
  Login 'device_merchant'
  Scroll-Text '商品管理'
  Product-Control ('product-reviews-' + $Identity.productId)
  Product-Control ('review-hide-' + $Order)
  Product-Control 'moderation-reason-无关内容'
  Product-Control 'moderation-submit'
  Wait-Text '评价已隐藏，买家可以查看原因并修改重发'
  $Hidden = Api 'device_buyer' ('/member/order/' + $Order)
  if ($Hidden.evaluation.hiddenReason -ne '无关内容' -or (Api 'device_buyer' ('/goods/' + $Identity.productId + '/evaluate/page')).counts -ne 0) { throw 'Hidden evaluation still public or reason missing' }
  Capture '07-merchant-review-hidden'
  Login 'device_buyer'
  Tap-Text '全部订单'
  Tap-Text '设备独立测试商品'
  Scroll-Text '已被商家隐藏：无关内容' -ViewOnly
  Capture '08-buyer-review-reason'
  Product-Control 'review-republish'
  $ReviewInputs = @(Read-Nodes | Where-Object { $_.type -eq 'TextArea' -and $_.visible -ne 'false' })
  if ($ReviewInputs.Count -ne 1) { throw 'Expected one editable review' }
  Operate-Node $ReviewInputs[0]
  Start-Sleep -Milliseconds 700
  $null = Invoke-Hdc @('shell','uitest','uiInput','keyEvent','2072','2017')
  $null = Invoke-Hdc @('shell','uitest','uiInput','text','Updated review about the actual product')
  Wait-Text 'Updated review about the actual product'
  if (@($script:Nodes | Where-Object id -eq 'keyboardLeftButton').Count) { Back }
  Tap-Text '修改后重新发布'
  for ($Attempt=0; $Attempt -lt 20; $Attempt++) {
    $Revised = Api 'device_buyer' ('/member/order/' + $Order)
    if (-not $Revised.evaluation.hiddenReason -and $Revised.evaluation.content -eq 'Updated review about the actual product') { break }
    Start-Sleep -Milliseconds 300
  }
  if ($Revised.evaluation.hiddenReason -or $Revised.evaluation.content -ne 'Updated review about the actual product') { throw 'Native republish did not restore evaluation' }
  $Visible = Api 'device_buyer' ('/goods/' + $Identity.productId + '/evaluate/page')
  if ($Visible.counts -ne 1 -or $Visible.items[0].content -ne 'Updated review about the actual product') { throw 'Republished evaluation not visible to buyers' }
  Tap-Text '设备独立测试商品'
  Scroll-Text 'Updated review about the actual product' -ViewOnly
  Capture '09-buyer-review-republished'
  $Audit = Api 'device_merchant' '/merchant/audit-log?pageSize=100'
  foreach ($Action in @('invoice.request','invoice.issued','review.hide','review.republish')) {
    if (@($Audit.items | Where-Object action -eq $Action).Count -ne 1) { throw ('Missing or repeated service audit action: ' + $Action) }
  }
  if (($Audit | ConvertTo-Json -Depth 15) -match 'service.invoice@example.test|91310000123456789A') { throw 'Invoice private fields leaked into audit' }
  Save-Result @{orderId=$Order;buyerId=$BuyerId;invoiceStatus=$Revised.invoice.status;replyRead=$true;otherBuyerPhotoDenied=$OtherDenied;reviewVisible=$Visible.counts;checks=@('native-checkout-invoice','native-issue-invoice','native-order-message-photo','native-merchant-reply','buyer-red-dot','buyer-read','native-hide-reason','native-republish','audit-private-fields')}
  Write-Output 'RESULT ServiceProbe native invoice, service reply and review republish passed'
}
