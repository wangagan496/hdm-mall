$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'verify-server.ps1')
& (Join-Path $PSScriptRoot 'verify-optimization.ps1')
Write-Output "SCRIPT $PSCommandPath RESULT server typecheck, server tests and client regression passed; native/device acceptance is separate"
