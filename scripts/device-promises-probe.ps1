function Open-PromisesAppearance {
  $null = Invoke-Hdc @('shell','aa','start','-a','com.huawei.hmos.settings.MainAbility','-b','com.huawei.hmos.settings')
  Wait-Text '显示和亮度'
  if (-not (Find-Text '显示模式')) { Tap-Text '显示和亮度' }
  Wait-Text '显示模式'
}

function Get-PromisesTheme {
  $selected = @(Read-Nodes | Where-Object { $_.selected -eq 'true' -and $_.text -match '^(浅色|深色),' })
  if ($selected.Count -ne 1) { throw 'Unable to read the selected device theme.' }
  if ($selected[0].text.StartsWith('深色')) { return 'dark' }
  return 'light'
}

function Set-PromisesTheme([string]$Theme) {
  $label = if ($Theme -eq 'dark') { '深色' } else { '浅色' }
  if ((Get-PromisesTheme) -ne $Theme) {
    $tab = Read-Nodes | Where-Object { $_.text -like "$label,*" } | Select-Object -First 1
    Operate-Node $tab
  }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if ((Get-PromisesTheme) -eq $Theme) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Device theme did not change to $Theme."
}

function Restore-PromisesTheme {
  Open-PromisesAppearance
  Set-PromisesTheme $OriginalPromisesTheme
  @{ original=$OriginalPromisesTheme; restored=(Get-PromisesTheme) } | ConvertTo-Json |
    Set-Content -LiteralPath "$Output/theme-restored.json" -Encoding utf8
}

function Save-PromisesCapture([string]$Name) {
  Capture $Name
  Add-Type -AssemblyName System.Drawing
  $sourcePath = Join-Path $Output "$Name.png"
  $image = [Drawing.Image]::FromFile($sourcePath)
  try {
    $width = 720
    $height = [int][math]::Round($image.Height * $width / $image.Width)
    $bitmap = [Drawing.Bitmap]::new($image, $width, $height)
    try {
      $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
      $settings = [Drawing.Imaging.EncoderParameters]::new(1)
      try {
        $settings.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, [long]80)
        $jpeg = Join-Path $Output "$Name.jpg"
        $bitmap.Save($jpeg, $codec, $settings)
      } finally { $settings.Dispose() }
    } finally { $bitmap.Dispose() }
  } finally { $image.Dispose() }
  if ((Get-Item -LiteralPath $jpeg).Length -gt 200000) { throw "Device JPEG exceeds 200KB: $Name" }
  Remove-Item -LiteralPath $sourcePath
}

function Read-PromisesDetail([string]$OrderId) {
  Login 'device_buyer' | Out-Host
  Tap-Text '待评价'
  Tap-Text '设备独立测试商品'
  Scroll-Text '下单时的商品承诺' -ViewOnly
  return (Api 'device_buyer' "/member/order/$OrderId")
}

function Invoke-PromisesProbe {
  Open-PromisesAppearance
  $script:OriginalPromisesTheme = Get-PromisesTheme
  Set-PromisesTheme $PromisesTheme
  Login 'device_merchant'
  Tap-Text '商品管理'
  $productId = $Identity.productId
  $promisePath = "/merchant/products/$productId/promises"
  Product-Control "product-promises-$productId"
  Product-Control 'product-promises-extract'
  Wait-Text '逐条确认草稿'
  Wait-Text '请看原文核对'
  $draftState = (Api 'device_merchant' $promisePath).draft
  $returnDraft = $draftState.entries | Where-Object fieldId -eq 'return-window' | Select-Object -First 1
  if (!$returnDraft.conditionNeedsReview -or $returnDraft.condition -ne '收货后') {
    throw 'The draft fixture does not preserve its partial condition for review.'
  }
  Save-PromisesCapture '01-merchant-draft'
  Product-Control 'promises-accept-return-window'
  Product-Control 'promises-accept-dispatch-window'
  Product-Control 'promises-accept-material'
  Product-Control 'promises-reject-gift'
  Product-Control 'product-promises-publish'
  Tap-Text '确认发布'
  Wait-Text '承诺已发布'
  $published = (Api 'device_merchant' $promisePath).published
  $known = @($published.entries | Where-Object status -eq 'known')
  if (!$published.receiptId -or ($known.fieldId -join ',') -notin @('return-window,dispatch-window,material','return-window,material,dispatch-window',
      'dispatch-window,return-window,material','dispatch-window,material,return-window','material,return-window,dispatch-window',
      'material,dispatch-window,return-window')) {
    throw 'Published result does not match the two merchant decisions.'
  }

  Login 'device_buyer'
  Checkout
  $orderId = (Orders)[0].id
  Tap-Text $PaymentText
  $paid = Assert-State $orderId 2
  $frozen = $paid.skus[0].promiseSnapshot
  if ($frozen.receiptId -ne $published.receiptId -or $paid.canCheckPromises) { throw 'Paid order snapshot or receipt gate failed.' }
  Login 'device_merchant'
  Tap-Text '店铺订单'
  Wait-Text '商家待发货订单'
  Scroll-Text '确认发货'
  Product-Control 'shipping-tracking-number' 'SF12345678'
  Product-Control 'shipping-submit'
  $null = Assert-State $orderId 3
  Login 'device_buyer'
  Tap-Text '待收货'
  Tap-Text '确认收货'
  $null = Assert-State $orderId 4
  $received = Read-PromisesDetail $orderId
  if (-not $received.canCheckPromises) { throw 'Confirmed buyer cannot check order promises.' }
  Scroll-Text '请看原文核对' -ViewOnly
  Wait-Text '请看原文核对'
  $script:Nodes = Read-Nodes
  $reviewNode = $script:Nodes | Where-Object id -eq "order-promise-condition-review-$SkuId-return-window" | Select-Object -First 1
  $returnValueNode = $script:Nodes | Where-Object id -eq "order-promise-value-$SkuId-return-window" | Select-Object -First 1
  if (!$reviewNode -or !$returnValueNode -or !$returnValueNode.text.Contains('7天') -or $reviewNode.text -ne '请看原文核对') {
    throw 'The order promise card did not show the flagged return-window value and review reminder.'
  }
  Save-PromisesCapture '03-buyer-frozen'
  Product-Control "order-promise-matches-$SkuId-return-window"
  Wait-Text '已核对：符合'
  Product-Control "order-promise-mismatch-$SkuId-dispatch-window"
  Wait-Text '申请售后'
  Wait-Text '请选择适合你的售后类型'
  Wait-Text '提交申请'
  $script:Nodes = Read-Nodes
  $selectedKinds = @($script:Nodes | Where-Object { $_.id -like 'after-sale-kind-*' -and $_.text -like '*✓ 已选*' })
  if ($selectedKinds.Count -ne 0) { throw 'A dispatch-window mismatch must leave the after-sale type unselected.' }
  $quoteNode = $script:Nodes | Where-Object id -eq 'after-sale-promise-quote' | Select-Object -First 1
  $dispatch = $known | Where-Object fieldId -eq 'dispatch-window' | Select-Object -First 1
  if (!$quoteNode -or !$quoteNode.text.Contains($dispatch.quote)) { throw 'The existing after-sale form lost the frozen source text.' }
  Save-PromisesCapture '04a-after-sale-dispatch-unselected'
  Back
  Product-Control "order-promise-mismatch-$SkuId-material"
  Wait-Text '申请售后'
  Wait-Text '质量问题退货 ✓ 已选'
  $script:Nodes = Read-Nodes
  $selectedKinds = @($script:Nodes | Where-Object { $_.id -like 'after-sale-kind-*' -and $_.text -like '*✓ 已选*' })
  if ($selectedKinds.Count -ne 1 -or $selectedKinds[0].id -ne 'after-sale-kind-return-quality') {
    throw 'A material mismatch must preselect the frozen quality-return suggestion.'
  }
  Save-PromisesCapture '04b-after-sale-material-quality-selected'
  Back
  $checked = Api 'device_buyer' "/member/order/$orderId"
  $checks = $checked.skus[0].promiseChecks
  if (($checks | Where-Object fieldId -eq 'return-window').result -ne 'matches' -or
      ($checks | Where-Object fieldId -eq 'dispatch-window').result -ne 'mismatch' -or
      ($checks | Where-Object fieldId -eq 'material').result -ne 'mismatch') { throw 'Buyer checks did not persist.' }

  Login 'device_merchant'
  Tap-Text '商品管理'
  Product-Control "product-edit-$productId"
  Wait-Text '编辑商品'
  Product-Control 'product-description' 'Updated device product description.'
  Scroll-Text '保存'
  Wait-Text '商品已保存'
  $edited = Api 'device_merchant' "/merchant/products/$productId"
  $afterEdit = Api 'device_merchant' $promisePath
  if ($edited.revision -le $published.productRevision -or $afterEdit.published.receiptId -ne $published.receiptId -or $afterEdit.draft) {
    throw 'Editing did not invalidate the draft and preserve the prior publication.'
  }
  $historical = Read-PromisesDetail $orderId
  $oldSnapshot = $frozen | ConvertTo-Json -Depth 10 -Compress
  $newSnapshot = $historical.skus[0].promiseSnapshot | ConvertTo-Json -Depth 10 -Compress
  if ($newSnapshot -cne $oldSnapshot) { throw 'Editing product information changed the historic order.' }
  Save-Result @{ theme=$PromisesTheme; orderId=$orderId; receiptId=$published.receiptId; checks=$checks;
    knownFields=@($known.fieldId); orderSnapshotUnchanged=$true; afterSaleFormContainsFrozenQuote=$true;
    orderPromiseReviewReminderVisible=$true;
    dispatchMismatchTypeUnselected=$true; materialMismatchPreselectedQualityReturn=$true;
    merchantDraftConditionNeedsReview=$returnDraft.conditionNeedsReview }
  Write-Output "SCRIPT $PSCommandPath RESULT $PromisesTheme stage 2A native trade and promise checks passed"
}
