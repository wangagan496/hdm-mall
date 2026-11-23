param([switch]$UseZhipu)
$ErrorActionPreference = 'Stop'
$serverRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'server'
$original = @{}
foreach ($name in @('ZHIPU_API_KEY', 'ZHIPU_API_KEY_FILE', 'ZHIPU_MOCK')) {
  $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location $serverRoot
try {
  Remove-Item Env:ZHIPU_API_KEY, Env:ZHIPU_API_KEY_FILE -ErrorAction SilentlyContinue
  $env:ZHIPU_MOCK = 'true'
  if ($UseZhipu) {
    $pointer = [IO.File]::ReadAllText((Join-Path $serverRoot '.env')).TrimEnd("`r", "`n")
    if ($pointer -notmatch '^ZHIPU_API_KEY_FILE=([^\r\n]+)$' -or -not [IO.Path]::IsPathFullyQualified($Matches[1])) {
      throw 'Configure a single absolute ZHIPU_API_KEY_FILE entry in server/.env.'
    }
    $env:ZHIPU_MOCK = 'false'
    $env:ZHIPU_API_KEY_FILE = $Matches[1]
  }
  Write-Output "SCRIPT $PSCommandPath RESULT starting local server with .env.example"
  & node --env-file=.env.example src/main.ts
  if ($LASTEXITCODE -ne 0) { throw 'Backend failed to start.' }
} finally {
  foreach ($name in $original.Keys) {
    [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process')
  }
  Pop-Location
}
