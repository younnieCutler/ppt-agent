param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$SlideMap  # "index,slideId;index,slideId;..." — caller resolves index from deck order
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'visual-lib.ps1')
$renderDir = Join-Path $OutputDir 'visual'
New-Item -ItemType Directory -Force -Path $renderDir | Out-Null

$slideMapEntries = New-Object 'System.Collections.Generic.List[object]'
foreach ($rawEntry in $SlideMap.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)) {
  $parts = $rawEntry -split ',', 2
  if ($parts.Count -ne 2) { throw "SlideMap entries must be index,slideId: $rawEntry" }
  [void]$slideMapEntries.Add([pscustomobject]@{ index = [int]$parts[0]; slideId = $parts[1] })
}
if ($slideMapEntries.Count -eq 0) { throw "SlideMap must contain at least one index,slideId entry." }

$powerPoint = $null
$presentation = $null
try {
  if (-not (Test-Path -LiteralPath $PptxPath)) { throw "PPTX not found: $PptxPath" }
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.Visible = 1
  $presentation = $powerPoint.Presentations.Open($PptxPath, 1, 1, 0)

  $index = New-Object 'System.Collections.Generic.List[object]'
  $labels = New-Object 'System.Collections.Generic.List[string]'
  $exportPosition = 0
  foreach ($entry in $slideMapEntries) {
    $exportPosition++
    if ($entry.index -lt 1 -or $entry.index -gt $presentation.Slides.Count) {
      throw "SlideMap entry '$($entry.slideId)' references PowerPoint slide index $($entry.index), but the presentation has $($presentation.Slides.Count) slides."
    }
    $pngPath = Join-Path $renderDir ("slide-{0:D3}.png" -f $exportPosition)
    $presentation.Slides.Item($entry.index).Export($pngPath, 'PNG', 1600, 900)
    [void]$index.Add([pscustomobject]@{ slideId = $entry.slideId; index = $entry.index; path = $pngPath })
    [void]$labels.Add($entry.slideId)
  }
  Write-JsonNoBom (Join-Path $renderDir 'index.json') $index.ToArray()
  New-Montage $renderDir (Join-Path $renderDir 'montage.png') $labels.ToArray()
  Write-JsonNoBom (Join-Path $renderDir 'backend.json') ([ordered]@{ backend = 'powerpoint'; backendVersion = [string]$powerPoint.Version; slideCount = $presentation.Slides.Count })
} finally {
  if ($presentation) { try { $presentation.Close() } catch {} }
  if ($powerPoint) { try { $powerPoint.Quit() } catch {} }
  if ($presentation) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($powerPoint) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) }
}
