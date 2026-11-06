param(
  [Parameter(Mandatory = $true)][string]$Account,
  [Parameter(Mandatory = $true)][string]$Password
)

$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:3000'
$loginBody = @{ account = $Account; password = $Password } | ConvertTo-Json
$login = Invoke-RestMethod -Method Post -Uri "$baseUrl/login" -ContentType 'application/json' -Body $loginBody
$headers = @{ Authorization = "Bearer $($login.result.token)" }
$addresses = Invoke-RestMethod -Method Get -Uri "$baseUrl/member/address" -Headers $headers
if (-not $addresses.result -or $addresses.result.Count -eq 0) {
  $addressBody = @{
    receiver = '模拟器验收'
    contact = '13800138000'
    fullLocation = '测试省 测试市 测试区'
    provinceCode = 'test-province'
    cityCode = 'test-city'
    countyCode = 'test-county'
    address = '设备验收地址'
    isDefault = 0
  } | ConvertTo-Json
  $null = Invoke-RestMethod -Method Post -Uri "$baseUrl/member/address" -Headers $headers -ContentType 'application/json' -Body $addressBody
}
$cart = Invoke-RestMethod -Method Get -Uri "$baseUrl/member/cart" -Headers $headers
if (-not $cart.result -or $cart.result.Count -eq 0) {
  $cartBody = @{ skuId = 'hdm-1-a'; count = 1; requestKey = [guid]::NewGuid().ToString() } | ConvertTo-Json
  $null = Invoke-RestMethod -Method Post -Uri "$baseUrl/member/cart" -Headers $headers -ContentType 'application/json' -Body $cartBody
}
Write-Output "Prepared one checkout address and one cart item for $Account."
