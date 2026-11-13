function Invoke-InventoryProbe {
  $Prepared = Invoke-RestMethod "$Base/device-fixture/inventory"
  $Partial = $Prepared.returned[0]
  $Pending = $Prepared.returned[1]
  $Before = (Api 'device_merchant' "/merchant/inventory?skuId=$SkuId").items[0]
  if ($Before.stock -ne ($InitialStock - 6) -or $Before.pendingInspectionCount -ne 3 -or $Before.rejectedReturnCount -ne 0) { throw 'Returned fixture inventory is inconsistent.' }
  Login 'device_merchant'
  Scroll-Text '售后处理'
  Product-Control 'after-sale-filter-returned'
  Scroll-Text '已寄回待验收 2 件（不入可售库存）' -ViewOnly
  if (@(Read-Nodes | Where-Object { $_.text -like '售后：*' }).Count) { throw 'After-sale card still displays an internal identifier.' }
  Capture '01-returned-before-inspection'
  Product-Control ('after-sale-inspect-' + $Partial.afterSaleId)
  Wait-Text '合格入库数量'
  Product-Control 'after-sale-restock-minus-0'
  $Count = Read-Nodes | Where-Object id -eq 'after-sale-restock-0' | Select-Object -First 1
  if ($Count.text -ne '1') { throw 'Partial inspection quantity did not update.' }
  Capture '02-partial-inspection-editor'
  Product-Control 'after-sale-confirm'
  $null = Wait-AfterSale $Partial.orderId 'refunded'
  Product-Control 'after-sale-filter-all'
  Scroll-Text '退回 2 件，合格入库 1 件，不合格 1 件（不入可售库存）' -ViewOnly
  Capture '03-partial-inspection-result'
  $Stock = (Api 'device_merchant' "/merchant/inventory?skuId=$SkuId").items[0]
  if ($Stock.stock -ne ($InitialStock - 5) -or $Stock.pendingInspectionCount -ne 1 -or $Stock.rejectedReturnCount -ne 1 -or $Stock.difference -ne 0) { throw 'Qualified stock or separate return quantities are incorrect.' }
  if (@($Stock.returnRecords | Where-Object { $_.afterSaleId -eq $Partial.afterSaleId -and $_.rejectedCount -eq 1 }).Count -ne 1) { throw 'Rejected units are not linked to their after-sale record.' }
  Mine
  Scroll-Text '库存管理'
  Scroll-Text ('可售库存：' + ($InitialStock - 5)) -ViewOnly
  Scroll-Text '已寄回待验收：1 件；验收不合格：1 件（均不入可售库存）' -ViewOnly
  Capture '04-inventory-separate-return-quantities'
  $Record = @($Stock.returnRecords | Where-Object afterSaleId -eq $Partial.afterSaleId)[0]
  $DateText = [DateTimeOffset]::FromUnixTimeMilliseconds($Record.createdAt).ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm')
  $RecordLabel = $Record.buyerAccount + ' · ' + $DateText + ' · 售后第 ' + $Record.sequence + ' 次'
  Scroll-Text $RecordLabel -ViewOnly
  if (@(Read-Nodes | Where-Object { $_.text -like '售后：*' }).Count) { throw 'Inventory still displays internal after-sale identifiers.' }
  Capture '05-inventory-readable-return-label'
  $null = Invoke-RestMethod "$Base/device-fixture/advance" -Method Post -ContentType 'application/json' -Body (@{ milliseconds=864000001 } | ConvertTo-Json)
  $AutoRefunded = Wait-AfterSale $Pending.orderId 'refunded'
  $BeforeLate = Payment-Proof $Pending.orderId
  $RefundsBefore = $BeforeLate.refunds | ConvertTo-Json -Depth 8 -Compress
  $Stock = (Api 'device_merchant' "/merchant/inventory?skuId=$SkuId").items[0]
  if ($Stock.stock -ne ($InitialStock - 5) -or $Stock.pendingInspectionCount -ne 1) { throw 'Automatic refund incorrectly restocked pending goods.' }
  Mine
  Scroll-Text '售后处理'
  Product-Control 'after-sale-filter-returned'
  Wait-Text '质量问题退货 · 已退款'
  Wait-Text '已寄回待验收 1 件（不入可售库存）'
  Capture '06-auto-refunded-still-pending-inspection'
  Product-Control ('after-sale-inspect-' + $Pending.afterSaleId)
  Wait-Text '确认补验收，仅记录入库'
  Wait-Text '退款已处理，本次只把合格的件数入库，不会再次退款'
  Capture '07-late-inspection-editor'
  Product-Control 'after-sale-confirm'
  Wait-Text '处理已完成'
  Product-Control 'after-sale-filter-all'
  Scroll-Text '退回 1 件，合格入库 1 件，不合格 0 件（不入可售库存）' -ViewOnly
  if (@(Read-Nodes | Where-Object { $_.text -like '售后：*' }).Count) { throw 'Late inspection card still displays an internal identifier.' }
  Capture '08-late-inspection-result'
  $AfterLate = Payment-Proof $Pending.orderId
  if (($AfterLate.refunds | ConvertTo-Json -Depth 8 -Compress) -ne $RefundsBefore) { throw 'Late inspection changed a refund or repeated a channel attempt.' }
  $Final = (Api 'device_merchant' "/merchant/inventory?skuId=$SkuId").items[0]
  $Moves = Api 'device_merchant' "/merchant/inventory/$SkuId/movements?pageSize=100"
  $Returns = @($Moves.items | Where-Object kind -eq 'return')
  if ($Final.stock -ne ($InitialStock - 4) -or $Final.pendingInspectionCount -ne 0 -or $Final.rejectedReturnCount -ne 1 -or $Final.difference -ne 0 -or $Returns.Count -ne 2 -or @($Returns | Where-Object delta -ne 1).Count -ne 0) { throw 'Final stock or return ledger is inconsistent.' }
  Mine
  Scroll-Text '库存管理'
  Scroll-Text ('可售库存：' + ($InitialStock - 4)) -ViewOnly
  Scroll-Text '已寄回待验收：0 件；验收不合格：1 件（均不入可售库存）' -ViewOnly
  Capture '09-final-inventory'
  $History = (Api 'device_merchant' "/merchant/inventory?skuId=$($Prepared.historySkuId)").items[0]
  if ($History.rejectedReturnCount -ne 5 -or $History.returnRecords.Count -ne 3 -or $History.hiddenRejectedRecordCount -ne 2) { throw 'History is not limited to three rejected records while preserving full totals.' }
  Mine
  Scroll-Text '库存管理'
  Scroll-Text '另有 2 条不合格记录' -ViewOnly
  Capture '10-rejected-history-limited'
  $HistoryLabels = @(Read-Nodes | Where-Object { $_.id -like ('inventory-return-label-' + $Prepared.historySkuId + '-*') })
  if ($HistoryLabels.Count -ne 3) { throw 'Inventory does not render exactly the three returned rejected records.' }
  Mine
  Scroll-Text '库存管理'
  Scroll-Text '库存对照商品 · 标准款' -ViewOnly
  Scroll-Text '可售库存：7' -ViewOnly
  if (@(Read-Nodes | Where-Object id -eq ('inventory-return-summary-' + $Prepared.emptySkuId)).Count) { throw 'Zero return quantities still render a summary.' }
  Capture '11-zero-return-summary-hidden'
  Save-Result @{ initial=$Before; partial=$Partial; pending=$Pending; partialInventory=$Stock; autoRefunded=$AutoRefunded; refundsBeforeLateInspection=$BeforeLate.refunds; refundsAfterLateInspection=$AfterLate.refunds; finalInventory=$Final; returnMovements=$Returns; readableReturnLabel=$RecordLabel; historyInventory=$History; zeroSummaryHidden=$true; nativeActions=@('partial-inspection','pending-inspection-visible','rejected-stock-visible','readable-return-label','late-inspection-only','final-inventory','latest-three-rejected-records','zero-summary-hidden') }
  Write-Output "SCRIPT $PSCommandPath RESULT InventoryProbe partial, pending, late inspection and stock ledger passed"
}
