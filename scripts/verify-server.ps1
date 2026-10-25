$ErrorActionPreference = 'Stop'

Push-Location (Join-Path $PSScriptRoot '..\server')
try {
  foreach ($scriptName in @('check', 'test')) {
    Write-Host "==> npm run $scriptName"
    npm run $scriptName
    if ($LASTEXITCODE -ne 0) {
      throw "npm run $scriptName failed with exit code $LASTEXITCODE."
    }
  }
} finally {
  Pop-Location
}
