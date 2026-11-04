param([string]$Path = '', [string]$Type = '')
$ErrorActionPreference = 'Stop'
if (-not $Path) { $Path = Join-Path (Split-Path $PSScriptRoot -Parent) '_device_acceptance/trade-layout.json' }
function Get-Nodes($Node) {
  if ($null -ne $Node.attributes) { $Node.attributes }
  foreach ($Child in $Node.children) { Get-Nodes $Child }
}
Get-Nodes (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) |
  Where-Object { if ($Type) { $_.type -eq $Type } else { $_.description -or $_.type -eq 'SymbolGlyph' } } |
  Select-Object type,text,description,bounds,clickable,id,key | ConvertTo-Json -Depth 4
Write-Output "SCRIPT $PSCommandPath RESULT saved layout inspected"
