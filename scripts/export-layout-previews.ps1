param(
  [Parameter(Mandatory = $true)][string]$TemplatePath,
  [Parameter(Mandatory = $true)][string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $TemplatePath).Path
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$destination = (Resolve-Path -LiteralPath $OutputDir).Path
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("ppt-agent-layout-" + [guid]::NewGuid().ToString() + '.pptx')
Copy-Item -LiteralPath $source -Destination $temporary
$app = $null
$presentation = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $app.Visible = 1
  $presentation = $app.Presentations.Open($temporary, 0, 0, 0)
  $layouts = $presentation.SlideMaster.CustomLayouts
  $index = @()
  for ($i = 1; $i -le $layouts.Count; $i++) {
    $slide = $presentation.Slides.AddSlide($presentation.Slides.Count + 1, $layouts.Item($i))
    $file = Join-Path $destination ("layout_{0:D2}.png" -f $i)
    $slide.Export($file, 'PNG', 960, 720)
    $slide.Delete()
    $index += [pscustomobject]@{ index = $i; name = $layouts.Item($i).Name; image = $file }
  }
  $index | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination 'index.json') -Encoding utf8
} finally {
  if ($presentation) { try { $presentation.Close() } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
  if ($presentation) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($app) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
