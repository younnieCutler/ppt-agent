param(
  [Parameter(Mandatory = $true)][string]$PptxPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [string]$SlideId = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'visual-lib.ps1')
$renderDir = Join-Path $OutputDir 'visual'
New-Item -ItemType Directory -Force -Path $renderDir | Out-Null
$slideIds = @($SlideId.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries))

$powerPoint = $null
$presentation = $null
try {
  if (-not (Test-Path -LiteralPath $PptxPath)) { throw "PPTX not found: $PptxPath" }
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.Visible = 1
  $presentation = $powerPoint.Presentations.Open($PptxPath, 1, 1, 0)

  $index = New-Object 'System.Collections.Generic.List[object]'
  $labels = New-Object 'System.Collections.Generic.List[string]'
  for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
    $slideId = if ($slideIndex -le $slideIds.Count) { $slideIds[$slideIndex - 1] } else { ('S{0:D2}' -f $slideIndex) }
    $pngPath = Join-Path $renderDir ("slide-{0:D3}.png" -f $slideIndex)
    $presentation.Slides.Item($slideIndex).Export($pngPath, 'PNG', 1600, 900)
    [void]$index.Add([pscustomobject]@{ slideId = $slideId; index = $slideIndex; path = $pngPath })
    [void]$labels.Add($slideId)
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
