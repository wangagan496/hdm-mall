$ErrorActionPreference = 'Stop'
$serverRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'server'
$envFile = if (Test-Path -LiteralPath (Join-Path $serverRoot '.env')) { '.env' } else { '.env.example' }
Push-Location $serverRoot
try {
  Write-Output "SCRIPT $PSCommandPath RESULT starting local server with $envFile"
  & node "--env-file=$envFile" src/main.ts
  if ($LASTEXITCODE -ne 0) { throw 'Backend failed to start.' }
} finally { Pop-Location }
