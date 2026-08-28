function Write-JsonNoBom([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 8
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function New-Montage([string]$Directory, [string]$OutputPath, [string[]]$Labels = @()) {
  Add-Type -AssemblyName System.Drawing
  $files = @(Get-ChildItem -LiteralPath $Directory -Filter '*.png' | Sort-Object Name)
  if ($files.Count -eq 0) { return }
  $thumbWidth = 480
  $thumbHeight = 270
  $columns = [Math]::Min(3, [Math]::Max(1, $files.Count))
  $rows = [Math]::Ceiling($files.Count / $columns)
  $canvas = [System.Drawing.Bitmap]::new([int]($columns * $thumbWidth), [int]($rows * ($thumbHeight + 24)))
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.Clear([System.Drawing.Color]::White)
  $font = [System.Drawing.Font]::new('Segoe UI', 10)
  for ($index = 0; $index -lt $files.Count; $index++) {
    $file = $files[$index]
    $label = if ($index -lt $Labels.Count) { $Labels[$index] } else { $file.BaseName }
    $image = [System.Drawing.Image]::FromFile($file.FullName)
    $x = ($index % $columns) * $thumbWidth
    $y = [Math]::Floor($index / $columns) * ($thumbHeight + 24)
    $graphics.DrawImage($image, $x, $y, $thumbWidth, $thumbHeight)
    $graphics.DrawString($label, $font, [System.Drawing.Brushes]::Black, $x + 4, $y + $thumbHeight + 3)
    $image.Dispose()
  }
  $canvas.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $canvas.Dispose()
}
