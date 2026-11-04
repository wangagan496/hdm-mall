param([string]$AppPath = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$Root = Split-Path $PSScriptRoot -Parent
if (-not $AppPath) { $AppPath = Join-Path $Root 'mixed-development-h5/build/outputs/default/mixed-development-h5-default-all-signed.app' }
$RawFile = Join-Path $Root 'mixed-development-h5/features/mine/src/main/resources/rawfile/index.html'
$Expected = (Get-FileHash -LiteralPath $RawFile -Algorithm SHA256).Hash
$App = [System.IO.Compression.ZipFile]::OpenRead($AppPath)
$Matched = 0
try {
  foreach ($Module in $App.Entries | Where-Object { $_.Name -match '\.(hap|hsp)$' }) {
    $ModuleStream = $Module.Open()
    $Memory = [System.IO.MemoryStream]::new()
    try {
      $ModuleStream.CopyTo($Memory)
      $Memory.Position = 0
      $Archive = [System.IO.Compression.ZipArchive]::new($Memory, [System.IO.Compression.ZipArchiveMode]::Read, $true)
      try {
        foreach ($Entry in $Archive.Entries | Where-Object { $_.FullName -match 'rawfile/.*index\.html$|rawfile/index\.html$' }) {
          $Stream = $Entry.Open()
          $Hasher = [System.Security.Cryptography.SHA256]::Create()
          try { $Actual = [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-', '') }
          finally { $Stream.Dispose(); $Hasher.Dispose() }
          if ($Actual -ne $Expected) { throw "Packaged H5 differs: $($Module.Name)/$($Entry.FullName)" }
          $Matched++
          Write-Output "MATCH $($Module.Name)/$($Entry.FullName) SHA256 $Actual"
        }
      } finally { $Archive.Dispose() }
    } finally { $ModuleStream.Dispose(); $Memory.Dispose() }
  }
} finally { $App.Dispose() }
if ($Matched -lt 1) { throw 'No packaged rawfile/index.html found.' }
Write-Output "SCRIPT $PSCommandPath RESULT packaged H5 matches source output ($Matched file)"
