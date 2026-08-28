param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$HeadingFont,
  [Parameter(Mandatory = $true)][string]$BodyFont,
  [Parameter(Mandatory = $true)][ValidateSet('managed_device', 'portable')][string]$FontDelivery,
  [string]$EastAsianFont = '',
  [switch]$RequirePageNumber,
  [switch]$RequireLogo,
  [string[]]$RequiredNativeObject = @(),
  [string[]]$ReservedZone = @(),
  [switch]$ProhibitTextImageOverlap,
  [switch]$NormalizeNonCoverTitles
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'visual-lib.ps1')
$findingList = New-Object 'System.Collections.Generic.List[object]'
$observedFonts = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$observedEastAsianFonts = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$renderDir = Join-Path $OutputDir 'visual'
New-Item -ItemType Directory -Force -Path $renderDir | Out-Null
$reservedZones = New-Object 'System.Collections.Generic.List[object]'
$requiredNativeObjects = @{}
$nativeObjectObservations = New-Object 'System.Collections.Generic.List[object]'
foreach ($rawObject in ($RequiredNativeObject -join ';').Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)) {
  $parts = $rawObject -split ',', 2
  if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) { throw "RequiredNativeObject must be slideId,kind: $rawObject" }
  if (-not $requiredNativeObjects.ContainsKey($parts[0])) { $requiredNativeObjects[$parts[0]] = New-Object 'System.Collections.Generic.List[string]' }
  [void]$requiredNativeObjects[$parts[0]].Add($parts[1])
}
foreach ($rawZone in $ReservedZone) {
  $parts = $rawZone -split ','
  if ($parts.Count -ne 6) { throw "ReservedZone must be slideId,id,x,y,width,height: $rawZone" }
  $zoneLeft = [double]$parts[2]
  $zoneTop = [double]$parts[3]
  $zoneWidth = [double]$parts[4]
  $zoneHeight = [double]$parts[5]
  [void]$reservedZones.Add([pscustomobject]@{ slideId = $parts[0]; id = $parts[1]; left = $zoneLeft; top = $zoneTop; right = $zoneLeft + $zoneWidth; bottom = $zoneTop + $zoneHeight })
}

function Add-Finding([string]$Severity, [string]$Code, [string]$Message, [string]$SlideId = '') {
  $finding = [ordered]@{ severity = $Severity; code = $Code; message = $Message }
  if ($SlideId) { $finding.slideId = $SlideId }
  [void]$findingList.Add([pscustomobject]$finding)
}

function Get-OverlapArea([object]$First, [object]$Second) {
  $overlapWidth = [Math]::Max(0, [Math]::Min($First.right, $Second.right) - [Math]::Max($First.left, $Second.left))
  $overlapHeight = [Math]::Max(0, [Math]::Min($First.bottom, $Second.bottom) - [Math]::Max($First.top, $Second.top))
  return $overlapWidth * $overlapHeight
}

$powerPoint = $null
$presentation = $null
try {
  if (-not (Test-Path -LiteralPath $PptxPath)) { throw "PPTX not found: $PptxPath" }
  $powerPoint = New-Object -ComObject PowerPoint.Application
  # Some Office installations reject hiding PowerPoint from an interactive session.
  # Keep the COM server visible and open the presentation without an additional window.
  $powerPoint.Visible = 1
  $presentation = $powerPoint.Presentations.Open($PptxPath, 1, 1, 0)
  $slideWidth = [double]$presentation.PageSetup.SlideWidth
  $slideHeight = [double]$presentation.PageSetup.SlideHeight
  $allowedFonts = @($HeadingFont, $BodyFont)

  for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
    $slide = $presentation.Slides.Item($slideIndex)
    $slideId = ('S{0:D2}' -f $slideIndex)
    $pngPath = Join-Path $renderDir ("slide-{0:D3}.png" -f $slideIndex)
    $slide.Export($pngPath, 'PNG', 1600, 900)
    $shapeRecords = New-Object 'System.Collections.Generic.List[object]'
    $nativeCounts = @{ text = 0; shapes = 0; connectors = 0; table = 0; chart = 0; source_image = 0 }
    for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
      $shape = $slide.Shapes.Item($shapeIndex)
      $left = [double]$shape.Left
      $top = [double]$shape.Top
      $right = $left + [double]$shape.Width
      $bottom = $top + [double]$shape.Height
      if ($left -lt -2 -or $top -lt -2 -or $right -gt ($slideWidth + 2) -or $bottom -gt ($slideHeight + 2)) {
        Add-Finding 'hard' 'OFF_CANVAS' "Shape $shapeIndex is outside the slide canvas." $slideId
      }
      $shapeType = [int]$shape.Type
      $isImage = $shapeType -in @(11, 13)
      $isConnector = ($shapeType -eq 9)
      try { $isConnector = $isConnector -or ($shape.Connector -eq -1) } catch {}
      $shapeRecord = [pscustomobject]@{ index = $shapeIndex; name = [string]$shape.Name; left = $left; top = $top; right = $right; bottom = $bottom; isText = $false; isImage = $isImage; isTitle = $false; paragraphAlignment = 0 }
      try {
        if ($shape.HasTextFrame -eq -1) {
          $textRange = $shape.TextFrame2.TextRange
          $preview = ([string]$textRange.Text).Replace("`r", " ").Replace("`n", " ").Trim()
          $shapeRecord.isText = -not [string]::IsNullOrWhiteSpace($preview)
          if ($shapeRecord.isText) { $nativeCounts.text += 1 }
          # Optional title normalization treats the first editable text shape as the title.
          $shapeRecord.isTitle = $shapeRecord.isText -and $shapeIndex -eq 1
          $shapeRecord.paragraphAlignment = [int]$shape.TextFrame.TextRange.ParagraphFormat.Alignment
          $boundHeight = [double]$textRange.BoundHeight
          if ($preview -and $boundHeight -gt ([double]$shape.Height + 4)) {
            if ($preview.Length -gt 80) { $preview = $preview.Substring(0, 80) }
            Add-Finding 'hard' 'TEXT_OVERFLOW' "Shape $shapeIndex '$([string]$shape.Name)' text bounds exceed its box: '$preview'." $slideId
          }
          $fontName = [string]$textRange.Font.Name
          if ($fontName) { [void]$observedFonts.Add($fontName) }
          if ($fontName -and ($allowedFonts -notcontains $fontName)) {
            Add-Finding 'hard' 'FONT_SUBSTITUTION' "Shape $shapeIndex uses '$fontName', outside the confirmed heading/body pair." $slideId
          }
        }
      } catch {
        # Some PowerPoint shapes expose no TextFrame2 metrics; geometry and open/export checks still apply.
      }
      if ($isImage) { $nativeCounts.source_image += 1 }
      if ($isConnector) { $nativeCounts.connectors += 1 }
      if ($shapeType -eq 19) { $nativeCounts.table += 1 }
      if ($shapeType -eq 3) { $nativeCounts.chart += 1 }
      if (-not $shapeRecord.isText -and -not $isImage -and -not $isConnector -and $shapeType -ne 19 -and $shapeType -ne 3) { $nativeCounts.shapes += 1 }
      [void]$shapeRecords.Add($shapeRecord)
    }
    foreach ($requiredKind in @($requiredNativeObjects[$slideId])) {
      if ([string]::IsNullOrEmpty($requiredKind)) { continue }
      if (-not $nativeCounts.ContainsKey($requiredKind) -or $nativeCounts[$requiredKind] -lt 1) {
        Add-Finding 'hard' 'NATIVE_OBJECT_MISSING' "Execution lock requires native '$requiredKind' but PowerPoint found none on this slide." $slideId
      }
    }
    [void]$nativeObjectObservations.Add([pscustomobject]@{ slideId = $slideId; counts = [pscustomobject]$nativeCounts })
    foreach ($zone in @($reservedZones | Where-Object { $_.slideId -eq $slideId })) {
      foreach ($record in @($shapeRecords | Where-Object { $_.isText })) {
        if ((Get-OverlapArea $record $zone) -gt 16) {
          Add-Finding 'hard' 'TEMPLATE_RESERVED_ZONE_COLLISION' "Text shape $($record.index) '$($record.name)' overlaps the reserved template zone '$($zone.id)'." $slideId
        }
      }
    }
    if ($ProhibitTextImageOverlap) {
      foreach ($textRecord in @($shapeRecords | Where-Object { $_.isText })) {
        foreach ($imageRecord in @($shapeRecords | Where-Object { $_.isImage })) {
          if ((Get-OverlapArea $textRecord $imageRecord) -gt 16) {
            Add-Finding 'hard' 'TEXT_IMAGE_COLLISION' "Text shape $($textRecord.index) '$($textRecord.name)' overlaps image shape $($imageRecord.index) '$($imageRecord.name)'." $slideId
          }
        }
      }
    }
    if ($NormalizeNonCoverTitles -and $slideIndex -gt 1) {
      foreach ($titleRecord in @($shapeRecords | Where-Object { $_.isTitle })) {
        if ($titleRecord.paragraphAlignment -ne 1) {
          Add-Finding 'hard' 'TITLE_ALIGNMENT_DRIFT' "Title shape $($titleRecord.index) '$($titleRecord.name)' is not left aligned." $slideId
        }
        if ([Math]::Abs($titleRecord.left - 36) -gt 2) {
          Add-Finding 'hard' 'TITLE_ANCHOR_DRIFT' "Title shape $($titleRecord.index) '$($titleRecord.name)' starts at $([Math]::Round($titleRecord.left, 1))pt instead of the requested title anchor." $slideId
        }
      }
    }
    if ($RequirePageNumber) {
      $pageFound = $false
      for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
        $candidate = $slide.Shapes.Item($shapeIndex)
        if ($candidate.Name -eq 'ppt-agent-page-number') { $pageFound = $true; break }
        try {
          if ($candidate.HasTextFrame -eq -1 -and [string]$candidate.TextFrame2.TextRange.Text -eq [string]$slideIndex) { $pageFound = $true; break }
        } catch {}
      }
      if (-not $pageFound) { Add-Finding 'hard' 'FOOTER_MISSING' 'Required page number was not found.' $slideId }
    }
    if ($RequireLogo) {
      $logoFound = $false
      for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
        $candidate = $slide.Shapes.Item($shapeIndex)
        try { if ([string]$candidate.AlternativeText -eq 'ppt-agent-logo') { $logoFound = $true; break } } catch {}
      }
      if (-not $logoFound) { Add-Finding 'hard' 'LOGO_MISSING' 'Required brand logo was not found.' $slideId }
    }
  }
  $embeddedFontParts = 0
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($PptxPath)
    $embeddedFontParts = @($archive.Entries | Where-Object { $_.FullName -like 'ppt/fonts/*' }).Count
    $archive.Dispose()
  } catch {
    Add-Finding 'warning' 'FONT_EMBEDDING_INSPECTION_FAILED' $_.Exception.Message
  }
  if ($FontDelivery -eq 'portable' -and $embeddedFontParts -eq 0) {
    Add-Finding 'hard' 'FONT_EMBEDDING_REQUIRED' 'Portable delivery was selected but the PPTX contains no embedded font parts.'
  }
  if ($EastAsianFont) {
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $archive = [System.IO.Compression.ZipFile]::OpenRead($PptxPath)
      foreach ($entry in @($archive.Entries | Where-Object { $_.FullName -match '^ppt/(slides|slideLayouts)/.*\.xml$' })) {
        $reader = New-Object System.IO.StreamReader($entry.Open())
        $xml = $reader.ReadToEnd()
        $reader.Dispose()
        foreach ($match in [regex]::Matches($xml, '<a:ea[^>]*typeface="([^"]+)"')) { [void]$observedEastAsianFonts.Add($match.Groups[1].Value) }
      }
      $archive.Dispose()
      if (-not @($observedEastAsianFonts | Where-Object { $_ -eq $EastAsianFont -or $_ -like "$EastAsianFont *" })) {
        Add-Finding 'hard' 'EAST_ASIAN_FONT_MISSING' "Expected East Asian font '$EastAsianFont' was not found in editable text runs."
      }
    } catch {
      Add-Finding 'hard' 'EAST_ASIAN_FONT_INSPECTION_FAILED' $_.Exception.Message
    }
  }
  New-Montage $renderDir (Join-Path $OutputDir 'montage.png')
  $status = if ($findingList.Count -eq 0) { 'pass' } else { 'fail' }
  Write-JsonNoBom (Join-Path $OutputDir 'powerpoint-qa.json') ([ordered]@{ status = $status; slideCount = $presentation.Slides.Count; fonts = [ordered]@{ delivery = $FontDelivery; allowed = $allowedFonts; observed = @($observedFonts | Sort-Object); eastAsianRequired = $EastAsianFont; eastAsianObserved = @($observedEastAsianFonts | Sort-Object); embeddedFontParts = $embeddedFontParts }; nativeObjects = $nativeObjectObservations.ToArray(); findings = $findingList.ToArray() })
} catch {
  Add-Finding 'hard' 'POWERPOINT_OPEN_OR_RENDER' $_.Exception.Message
  Write-JsonNoBom (Join-Path $OutputDir 'powerpoint-qa.json') ([ordered]@{ status = 'fail'; findings = $findingList.ToArray() })
  exit 1
} finally {
  if ($presentation) { try { $presentation.Close() } catch {} }
  if ($powerPoint) { try { $powerPoint.Quit() } catch {} }
  if ($presentation) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($powerPoint) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) }
}
