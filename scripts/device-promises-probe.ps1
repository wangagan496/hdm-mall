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
  if ($Stage2bAcceptance -and $Name -ne 'failure' -and $Name -notin @('01-material-upload','03-merchant-draft-material-source','04-buyer-source-v1','08-historic-order-source-v1')) { return }
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

function Select-Stage2bTestPhoto {
  if ((Find-Stage2bPhoto $script:Stage2bPhotoInfo.displayName) -cne $script:Stage2bPhotoInfo.devicePath) { throw 'Test photo URI changed.' }
  $prefix = '^ThirdSelectAlbumGridBase_GridItem\(?' + [regex]::Escape($script:Stage2bPhotoInfo.devicePath) + '\)?(?:\?|$)'
  try {
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
      $nodes = @(Read-Nodes | Where-Object { $_.visible -ne 'false' -and $_.id -cmatch $prefix })
      if ($nodes.Count -gt 1) { throw 'Ambiguous picker control.' }
      if ($nodes.Count -eq 1) { Operate-Node $nodes[0]; return }
      Start-Sleep -Milliseconds 350
    }
    throw 'The system picker did not present the verified test photo.'
  } finally {
    Remove-Item -LiteralPath (Join-Path $Output 'layout.json') -Force -ErrorAction SilentlyContinue
  }
}

function Read-PromisesDetail([string]$OrderId) {
  Login 'device_buyer' | Out-Host
  Tap-Text '待评价'
  Tap-Text '设备独立测试商品'
  Scroll-Text '下单时的商品承诺' -ViewOnly
  return (Api 'device_buyer' "/member/order/$OrderId")
}

function Show-Stage2bText([string]$Text,[int]$MaxTop=1500) {
  for ($i=0; $i -lt 14; $i++) {
    $script:Nodes = Read-Nodes
    $node = Find-Text $Text
    if ($node -and $node.bounds -match '^\[\d+,(\d+)\]\[\d+,(\d+)\]$' -and [int]$Matches[1] -ge 235 -and [int]$Matches[1] -le $MaxTop) { return }
    if ($node -and $node.bounds -match '^\[\d+,(\d+)\]' -and [int]$Matches[1] -lt 235) {
      $null=Invoke-Hdc @('shell','uitest','uiInput','swipe','660','1050','660','1520','550')
    } else {
      $null=Invoke-Hdc @('shell','uitest','uiInput','swipe','660','1760','660','1260','550')
    }
  }
  throw "Could not frame source evidence: $Text"
}

function Upload-Stage2bMaterial([int]$Version) {
  Product-Control 'product-source-materials'
  Wait-Text '来源材料'
  Wait-Text 'LOT-2026-A'
  $summary = if ($Version -eq 1) { '材质成分为100%纯棉。' } else { '材质成分为100%纯棉，报告更新。' }
  if ($Stage2bAcceptance -and $Version -eq 1) {
    Product-Control 'source-material-batch' 'LOT-2026-A'
    Product-Control 'source-material-save-batch'
    Product-Control 'source-material-valid-from' '2026-11-01'
    Product-Control 'source-material-valid-through' '2026-12-31'
  }
  Product-Control 'source-material-summary' $summary
  $uploadCapture = if ($Version -eq 1) { '01-material-upload' } else { '06-material-upload-v2' }
  $pickerCapture = if ($Version -eq 1) { '02-photo-picker-v1' } else { '06a-photo-picker-v2' }
  $savedCapture = if ($Version -eq 1) { '02a-material-uploaded-v1' } else { '07-material-uploaded-v2' }
  Save-PromisesCapture $uploadCapture
  Product-Control 'source-material-upload'
  Wait-Text '安全访问图库'
  $libraryPromptCapture = if ($Version -eq 1) { '02-photo-library-authorization' } else { '06b-photo-library-authorization-v2' }
  $photoSelectionCapture = if ($Version -eq 1) { '02b-photo-selected' } else { '06c-photo-selected-v2' }
  Save-PromisesCapture $libraryPromptCapture
  if ($Stage2bAcceptance) { Select-Stage2bTestPhoto }
  else { Product-Control 'imageGridItem' }
  Wait-Text '完成'
  Save-PromisesCapture $photoSelectionCapture
  Tap-Text '完成'
  for ($attempt = 0; $attempt -lt 16; $attempt++) {
    $records = (Api 'device_merchant' "/merchant/products/$($Identity.productId)/source-materials").materials
    $record = $records | Where-Object { $_.kind -eq 'inspection-report' -and $_.version -eq $Version } | Select-Object -First 1
    if ($record) { break }
    Start-Sleep -Milliseconds 350
  }
  if (!$record -or $record.batch -ne 'LOT-2026-A' -or $record.verificationStatus -ne 'pending') {
    throw "Stage 2B material version $Version did not persist with the expected batch and status."
  }
  Scroll-Text ('检验报告 · 第 ' + $Version + ' 版') -ViewOnly
  Save-PromisesCapture $savedCapture
  if ($Stage2bAcceptance -and $Version -eq 2) { Clear-Stage2bPhoto }
  Back
  Wait-Text '商品承诺'
  return $record
}

function Invoke-PromisesProbe {
  if ($Stage2bAcceptance) { Initialize-Stage2bPhoto }
  Open-PromisesAppearance
  $script:OriginalPromisesTheme = Get-PromisesTheme
  Set-PromisesTheme $PromisesTheme
  Login 'device_merchant'
  Tap-Text '商品管理'
  $productId = $Identity.productId
  $promisePath = "/merchant/products/$productId/promises"
  Product-Control "product-promises-$productId"
  $materialV1 = Upload-Stage2bMaterial 1
  Product-Control 'product-promises-extract'
  Wait-Text '逐条确认草稿'
  Wait-Text '请看原文核对'
  $draftState = (Api 'device_merchant' $promisePath).draft
  $returnDraft = $draftState.entries | Where-Object fieldId -eq 'return-window' | Select-Object -First 1
  if (!$returnDraft.conditionNeedsReview -or $returnDraft.condition -ne '收货后') {
    throw 'The draft fixture does not preserve its partial condition for review.'
  }
  $materialDraft = $draftState.entries | Where-Object { $_.fieldId -eq 'material' -and $_.sourceRef.field -eq 'material' } | Select-Object -First 1
  if (!$materialDraft -or $materialDraft.sourceRef.materialId -ne $materialV1.materialId -or
      $materialDraft.sourceRevision -ne 1 -or $materialDraft.quote -ne $materialV1.summary) {
    throw 'The material-derived promise did not retain its material ID, version, and quoted text.'
  }
  Product-Control 'promises-accept-return-window'
  Product-Control 'promises-accept-dispatch-window'
  Show-Stage2bText ('材料说明原文 · 第 1 版：' + $materialV1.summary)
  Save-PromisesCapture '03-merchant-draft-material-source'
  Product-Control 'promises-accept-material'
  Scroll-Text '赠品：赠送收纳袋' -ViewOnly -Reverse
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
  $materialPublished = $known | Where-Object { $_.fieldId -eq 'material' -and $_.sourceRef.field -eq 'material' } | Select-Object -First 1
  if (!$materialPublished -or $materialPublished.sourceRef.materialId -ne $materialV1.materialId -or $materialPublished.sourceRevision -ne 1) {
    throw 'Published material promise changed its confirmed source reference.'
  }

  Login 'device_buyer'
  Checkout
  $orderId = (Orders)[0].id
  Tap-Text $PaymentText
  $paid = Assert-State $orderId 2
  $frozen = $paid.skus[0].promiseSnapshot
  if ($frozen.receiptId -ne $published.receiptId -or $paid.canCheckPromises) { throw 'Paid order snapshot or receipt gate failed.' }
  if ($paid.skus[0].promiseSources[0].record.version -ne 1 -or
      $paid.skus[0].promiseSources[0].record.verificationStatus -ne 'pending') {
    throw 'The order did not freeze the pending first material version.'
  }
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
  Product-Control "order-promise-source-$SkuId-material"
  Show-Stage2bText '检验报告 · 第 1 版' 850
  $validFrom = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$materialV1.validFrom).ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd')
  $validUntil = [DateTimeOffset]::FromUnixTimeMilliseconds([long]($materialV1.validUntil - 1)).ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd')
  Wait-Text '检验报告 · 第 1 版'
  Wait-Text '适用批次：LOT-2026-A'
  Wait-Text ('有效期：' + $validFrom + ' 至 ' + $validUntil)
  Wait-Text '下单时：商家提供 · 待核验'
  Wait-Text '已核验也只表示所列检查完成，不保证商品为真'
  Wait-Text '上传成功不等于保真'
  $script:Nodes = Read-Nodes
  $sourceVersion = $script:Nodes | Where-Object id -eq "order-promise-source-$SkuId-material-version" | Select-Object -First 1
  if (!$sourceVersion -or $sourceVersion.text -ne '检验报告 · 第 1 版' -or (Find-Text '查看原件')) {
    throw 'The buyer source panel did not show the frozen version or exposed an original-file action.'
  }
  Save-PromisesCapture '04-buyer-source-v1'
  if (!$Stage2bAcceptance) {
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
  }

  Login 'device_merchant'
  Tap-Text '商品管理'
  Product-Control "product-promises-$productId"
  $materialV2 = Upload-Stage2bMaterial 2
  Login 'device_buyer'
  $historical = Read-PromisesDetail $orderId
  $oldRecord = $historical.skus[0].promiseSources[0]
  if ($oldRecord.record.version -ne 1 -or $oldRecord.record.materialId -ne $materialV1.materialId -or
      ($historical.skus[0].promiseSnapshot | ConvertTo-Json -Depth 10 -Compress) -cne ($frozen | ConvertTo-Json -Depth 10 -Compress)) {
    throw 'Uploading a second material version changed the historic order source.'
  }
  Product-Control "order-promise-source-$SkuId-material"
  Show-Stage2bText '检验报告 · 第 1 版' 1250
  Wait-Text '检验报告 · 第 1 版'
  Save-PromisesCapture '08-historic-order-source-v1'
  if ($Stage2bAcceptance) {
    Save-Result @{theme=$PromisesTheme;orderId=$orderId;receiptId=$published.receiptId;knownFields=@($known.fieldId);
      materialVersion1=$materialV1.version;materialVersion2=$materialV2.version;orderSourceRemainedVersion1=$true;
      buyerOriginalHidden=$true;buyerSourcePanelVisible=$true;orderSnapshotUnchanged=$true;
      syntheticPhoto=$script:Stage2bPhotoInfo;syntheticPhotoCleanup=$script:Stage2bPhotoCleanup}
    return
  }
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
    orderPromiseReviewReminderVisible=$true; materialVersion1=$materialV1.version; materialVersion2=$materialV2.version;
    orderSourceRemainedVersion1=$true; buyerOriginalHidden=$true; buyerSourcePanelVisible=$true;
    dispatchMismatchTypeUnselected=$true; materialMismatchPreselectedQualityReturn=$true;
    merchantDraftConditionNeedsReview=$returnDraft.conditionNeedsReview; syntheticPhoto=$script:Stage2bPhotoInfo; syntheticPhotoCleanup=$script:Stage2bPhotoCleanup }
  Write-Output "SCRIPT $PSCommandPath RESULT $PromisesTheme stage 2B source records and native trade checks passed"
}
function Invoke-FitReasonProbe {
  $script:SizingAlbumBefore = Get-Stage2bAlbumCount
  Open-PromisesAppearance
  $script:OriginalPromisesTheme = Get-PromisesTheme
  Set-PromisesTheme $PromisesTheme
  $address = @(Api 'device_buyer' '/member/address')[0]
  $cases = @(
    @{sku=$SkuId; amount=$AmountCents; label='设备独立测试商品'; applicable=$true; capture='01-apparel'},
    @{sku=$Identity.sizingBagSkuId; amount=1200; label='轻便验收包'; applicable=$false; capture='02-bag'}
  )
  foreach ($case in $cases) {
    $order = Api 'device_buyer' '/member/order' 'Post' @{source='buy-now'; addressId=$address.id; requestKey=[guid]::NewGuid().ToString();
      expectedAmountCents=$case.amount; goods=@(@{skuId=$case.sku;count=1})}
    $case.orderId = $order.id
    $null = Api 'device_buyer' "/member/order/$($order.id)/mock-pay" 'Post' @{amountCents=$case.amount}
    $null = Api 'device_merchant' "/merchant/orders/$($order.id)/ship" 'Post' @{carrier='顺丰';trackingNo='SF12345678'}
  }
  Login 'device_buyer'
  Tap-Text '待收货'
  foreach ($case in $cases) {
    Product-Control ('order-apply-after-sale-' + $case.orderId)
    Wait-Text '提交申请'
    Wait-Text ($case.label + ' · 标准款')
    $anchor = if ($case.applicable) { '个人穿着不合适' } else { '少件漏发仅退款' }
    Show-Stage2bText $anchor 2000
    $nodes = @(Read-Nodes)
    $personalFit = @($nodes | Where-Object { $_.id -eq 'after-sale-personal-fit' -and $_.visible -ne 'false' })
    if ($personalFit.Count -ne [int]$case.applicable) { throw 'Unexpected personal fit control for selected goods.' }
    if (!($nodes | Where-Object { $_.id -eq 'after-sale-kind-return-no-reason' -and $_.text -like '*已选*' })) { throw 'No-reason return is not selected.' }
    Save-PromisesCapture $case.capture
    Back
    $confirmed = Assert-State $case.orderId 3
    if (@($confirmed.afterSales).Count -ne 0 -or @((Payment-Proof $case.orderId).refunds).Count -ne 0) { throw 'Unexpected after-sale or refund.' }
  }
  Save-Result @{theme=$PromisesTheme; cases=$cases; afterSaleCount=0; refundCount=0}
}

function Invoke-SizingProbe {
  $script:SizingAlbumBefore = Get-Stage2bAlbumCount
  Open-PromisesAppearance
  $script:OriginalPromisesTheme = Get-PromisesTheme
  Set-PromisesTheme $PromisesTheme
  Login 'device_merchant'
  Tap-Text '商品管理'
  Product-Control "product-promises-$($Identity.productId)"
  Product-Control 'product-promises-extract'
  Wait-Text '逐条确认草稿'
  $draft = (Api 'device_merchant' "/merchant/products/$($Identity.productId)/promises").draft
  Write-Output ('CHECK sizing draft ' + (($draft.entries | Where-Object { $_.fieldId -in @('size-chart','fit') } | Select-Object fieldId,status,value) | ConvertTo-Json -Compress))
  Product-Control 'promises-accept-size-chart'
  Product-Control 'promises-accept-fit'
  Save-PromisesCapture '01-draft'
  Product-Control 'product-promises-publish'
  Tap-Text '确认发布'
  Wait-Text '承诺已发布'
  $publication = (Api 'device_merchant' "/merchant/products/$($Identity.productId)/promises").published
  if (($publication.entries | Where-Object fieldId -eq 'fit').fit -ne '偏大') { throw 'Published fit mismatch' }
  Login 'device_buyer'
  Product-Search '设备独立测试商品'
  Tap-Text '详情'
  Wait-Text '尺码与版型'
  Wait-Text '✓ 偏大'
  Wait-Text '偏小'
  Wait-Text '标准'
  Wait-Text '原文：版型偏大，建议选小一码'
  Save-PromisesCapture '02-goods'
  Product-Search '轻便验收包'
  Tap-Text '详情'
  Wait-Text '商品详情'
  if (@(Read-Nodes | Where-Object id -eq 'goods-sizing').Count) { throw 'Bag has apparel fit panel' }
  Save-PromisesCapture '03-bag'
  Mine
  Checkout
  $orderId = (Orders)[0].id
  Tap-Text $PaymentText
  $null = Assert-State $orderId 2
  Login 'device_merchant'
  Tap-Text '店铺订单'
  Scroll-Text '确认发货'
  Product-Control 'shipping-tracking-number' 'SF12345678'
  Product-Control 'shipping-submit'
  $null = Assert-State $orderId 3
  Login 'device_buyer'
  Tap-Text '待收货'
  Tap-Text '确认收货'
  $null = Assert-State $orderId 4
  $detail = Read-PromisesDetail $orderId
  if ($detail.skus[0].promiseSnapshot.receiptId -ne $publication.receiptId) { throw 'Frozen receipt mismatch' }
  Show-Stage2bText '版型：偏大'
  Save-PromisesCapture '04-order'
  Product-Control "order-promise-mismatch-$SkuId-fit"
  Wait-Text '尺码与承诺不符'
  Wait-Text '请选择适合你的售后类型'
  Wait-Text '商品资料原文：版型偏大，建议选小一码'
  if (@(Read-Nodes | Where-Object { $_.id -like 'after-sale-kind-*' -and $_.text -like '*已选*' }).Count) { throw 'After-sale kind preselected' }
  Save-PromisesCapture '05-after-sale'
  Save-Result @{ theme=$PromisesTheme; knownFields=@($publication.entries | Where-Object status -eq 'known' | ForEach-Object fieldId); orderId=$orderId; receiptId=$publication.receiptId; fit='偏大'; bagPanelAbsent=$true; afterSaleKindUnselected=$true }
}
