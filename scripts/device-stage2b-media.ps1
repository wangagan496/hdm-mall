# Read only directory metadata. Keep other assets' names out of the probe output.
function Initialize-Stage2bPhoto {
  if ($Stage2bPhotoUri) {
    $name = ($Stage2bPhotoUri -split '/')[-1]
    if ($name -cnotmatch '^hdm-report-[a-f0-9]{32}\.jpg$' -or $Stage2bMediaCountBefore -ne 1 -or
        (Find-Stage2bPhoto $name) -cne $Stage2bPhotoUri -or (Get-Stage2bPhotoHash $Stage2bPhotoUri) -ne $Stage2bPhotoSha256) { throw 'Pre-imported test file does not match the transfer record.' }
    $script:Stage2bPhotoInfo = @{displayName=$name; devicePath=$Stage2bPhotoUri; sha256=$Stage2bPhotoSha256; mediaCountBeforeWrite=$Stage2bMediaCountBefore}
  } else {
    $name = 'hdm-report-' + [guid]::NewGuid().ToString('N') + '.jpg'
    $before = Get-Stage2bAlbumCount
    if ($before -ne 1 -or (Find-Stage2bPhoto $name)) { throw 'Expected original album baseline and an unused test name.' }
    $hostFile = Join-Path ([IO.Path]::GetTempPath()) $name
    $deviceFile = "/data/local/tmp/$name"
    $shared = "/data/service/el2/100/hmdfs/account/files/Docs/Download/$name"
    Add-Type -AssemblyName System.Drawing
    $bitmap = [Drawing.Bitmap]::new(120,80)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $g.Clear([Drawing.Color]::Teal)
      $g.FillRectangle([Drawing.Brushes]::White,12,12,80,5)
      $bitmap.Save($hostFile,[Drawing.Imaging.ImageFormat]::Jpeg)
    } finally { $g.Dispose(); $bitmap.Dispose() }
    try {
      $script:Stage2bPhotoInfo = @{displayName=$name; devicePath=''; sha256=(Get-FileHash $hostFile).Hash; mediaCountBeforeWrite=$before}
      $script:Stage2bPhotoInfo | ConvertTo-Json | Set-Content "$Output/test-photo.json"
      $null = Invoke-Hdc @('file','send',$hostFile,$deviceFile)
      $copy = Invoke-Hdc @('shell','cp','-n',$deviceFile,$shared)
      if ($copy -or ((Invoke-Hdc @('shell','sha256sum',$shared)) -join '') -notmatch $script:Stage2bPhotoInfo.sha256) { throw 'Staged Downloads copy could not be verified.' }
      $null = Invoke-Hdc @('shell','aa','force-stop','com.huawei.hmos.filemanager')
      $null = Invoke-Hdc @('shell','aa','start','-b','com.huawei.hmos.filemanager','-a','MainAbility')
      for ($step=0; $step -lt 8; $step++) {
        $script:Nodes = Read-Nodes
        $item = Find-Text $name
        if ($item) { break }
        if ((Find-Text 'Download') -and $step -lt 4) { Operate-Node (Find-Text 'Download') }
        elseif (Find-Text '我的手机') { Operate-Node (Find-Text '我的手机') }
        elseif ($step -gt 0) { Back }
        Start-Sleep -Milliseconds 450
      }
      if (!$item) { throw 'System Files did not present the generated JPEG.' }
      $box = [regex]::Matches($item.bounds,'\d+') | ForEach-Object { [int]$_.Value }
      $x = [int](($box[0]+$box[2])/2)
      $y = [int](($box[1]+$box[3])/2)
      $null = Invoke-Hdc @('shell','uitest','uiInput','longClick',"$x","$y")
      Tap-Text '分享'
      Tap-Text '保存至图库'
      for ($i=0; $i -lt 15; $i++) {
        $script:Stage2bPhotoInfo.devicePath = Find-Stage2bPhoto $name
        if ($script:Stage2bPhotoInfo.devicePath) { break }
        Start-Sleep -Milliseconds 350
      }
      if (!$script:Stage2bPhotoInfo.devicePath) { throw 'System Files did not publish a URI for the generated JPEG.' }
      # A URI may appear before System Files finishes copying the backing file.
      for ($retry=0; $retry -lt 16; $retry++) {
        try {
          $importedHash = Get-Stage2bPhotoHash $script:Stage2bPhotoInfo.devicePath
          break
        } catch {
          if ($_.Exception.Message -notmatch 'open source media file failed' -or $retry -eq 15) { throw }
          Start-Sleep -Milliseconds 500
        }
      }
      if ($importedHash -ne $script:Stage2bPhotoInfo.sha256) { throw 'Imported album file did not match the generated JPEG.' }
    } finally {
      Remove-Item -LiteralPath $hostFile -Force -ErrorAction SilentlyContinue
      $null = Invoke-Hdc @('shell','rm','-f',$deviceFile,$shared)
      Remove-Item -LiteralPath "$Output/layout.json" -Force -ErrorAction SilentlyContinue
    }
  }
  $script:Stage2bPhotoInfo.mediaCountAfterWrite = Get-Stage2bAlbumCount
  if ($script:Stage2bPhotoInfo.mediaCountAfterWrite -ne ($script:Stage2bPhotoInfo.mediaCountBeforeWrite+1)) { throw 'Imported album count did not increase by one.' }
  $script:Stage2bPhotoInfo | ConvertTo-Json | Set-Content "$Output/test-photo.json"
}

function Clear-Stage2bPhoto {
  $photo = $script:Stage2bPhotoInfo
  if (!$photo -or $script:Stage2bPhotoCleanup) { return }
  $uri = Find-Stage2bPhoto $photo.displayName
  if (!$uri) {
    if ($photo.devicePath -or (Get-Stage2bAlbumCount) -ne $photo.mediaCountBeforeWrite) { throw 'Unexpected album state during cleanup.' }
    return
  }
  $script:Stage2bPhotoCleanup = Remove-Stage2bVerifiedPhoto $uri $photo.sha256 $photo.mediaCountBeforeWrite
  @{created=1; removed=1; entries=@($script:Stage2bPhotoCleanup)} | ConvertTo-Json -Depth 5 | Set-Content "$Output/media-cleanup.json"
}

function Get-Stage2bAlbumCount {
  $root = '/storage/media/local/files/Photo'
  $dirs = @(Invoke-Hdc @('shell','mediatool','ls','-l',$root))
  $count = 0
  foreach ($dir in $dirs) {
    if ($dir -match '^d.*\s(\d+)\s*$') {
      $bucket = $Matches[1]
      $lines = @(Invoke-Hdc @('shell','mediatool','ls','-l',"$root/$bucket"))
      if ($lines -match 'usage:|[Pp]ermission denied|[Nn]o such file') { throw 'Unable to count media assets.' }
      $count += @($lines | Where-Object { $_ -match '^-.+\.(jpe?g|png|gif|webp|heic|heif|bmp|dng|avif)\s*$' }).Count
    } elseif ($dir.Trim() -and $dir -notmatch '^total\s+\d+') { throw 'Unrecognized media bucket listing.' }
  }
  return $count
}

function Find-Stage2bPhoto([string]$Name) {
  if ($Name -cnotmatch '^(?:hdm-report-[a-f0-9]{32}|screenshot_20261119_222245)\.jpg$') { throw 'Unexpected test asset name.' }
  $result = @(Invoke-Hdc @('shell','mediatool','query',$Name,'-u'))
  if ($result -match '^find 0 result\s*$') { return }
  $uris = @($result | ForEach-Object { $_.Trim().Trim('"') } | Where-Object {
    $_ -cmatch ('^file://media/Photo/\d+/[A-Za-z0-9_]+/' + [regex]::Escape($Name) + '$')
  })
  if (!($result -match '^find 1 result\s*$') -or $uris.Count -ne 1) { throw 'Could not uniquely identify the named test asset.' }
  return $uris[0]
}

function Get-Stage2bPhotoHash([string]$Uri) {
  $file = 'hdm-hash-' + [guid]::NewGuid().ToString('N') + '.jpg'
  $deviceFile = '/data/local/tmp/' + $file
  $hostFile = Join-Path ([IO.Path]::GetTempPath()) $file
  try {
    $null = Invoke-Hdc @('shell','mediatool','recv',$Uri,$deviceFile)
    $null = Invoke-Hdc @('file','recv',$deviceFile,$hostFile)
    if (!(Test-Path -LiteralPath $hostFile -PathType Leaf)) { throw 'Media export did not produce a host file.' }
    return (Get-FileHash -LiteralPath $hostFile).Hash
  } finally {
    Remove-Item -LiteralPath $hostFile -Force -ErrorAction SilentlyContinue
    $null = Invoke-Hdc @('shell','rm','-f',$deviceFile)
  }
}

function Remove-Stage2bVerifiedPhoto([string]$Uri,[string]$Hash,[int]$ExpectedRemaining) {
  $name = ($Uri -split '/')[-1]
  if ((Find-Stage2bPhoto $name) -cne $Uri) { throw 'Test asset URI changed. No deletion attempted.' }
  $observedHash = Get-Stage2bPhotoHash $Uri
  if ($observedHash -ne $Hash) { throw 'Test asset hash mismatch. No deletion attempted.' }
  $before = Get-Stage2bAlbumCount
  if ($before -ne ($ExpectedRemaining + 1)) { throw "Unexpected count before deletion: $before." }
  $deleted = Invoke-Hdc @('shell','mediatool','delete',$Uri)
  if (($deleted -join '') -notmatch 'delete success') { throw 'Media tool did not confirm deletion.' }
  for ($i=0; $i -lt 12; $i++) {
    $remaining = Get-Stage2bAlbumCount
    if (!(Find-Stage2bPhoto $name) -and $remaining -eq $ExpectedRemaining) {
      return @{ devicePath=$Uri; displayName=$name; sha256=$observedHash; deleted=$true; mediaCountBeforeDelete=$before; mediaCountAfterDelete=$remaining; countRestored=$true }
    }
    Start-Sleep -Milliseconds 300
  }
  throw "Deletion reported success; remaining count $remaining requires reconciliation."
}
