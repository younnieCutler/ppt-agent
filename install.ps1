param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path -LiteralPath $PSScriptRoot).Path

if (-not $SkipInstall) {
  npm.cmd install
}
npm.cmd run build

$userProfilePath = [Environment]::GetFolderPath('UserProfile')
$skillsRoot = Join-Path $userProfilePath '.claude\skills'
$targetPath = Join-Path $skillsRoot 'ppt'
New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null

if (Test-Path -LiteralPath $targetPath) {
  $item = Get-Item -LiteralPath $targetPath -Force
  $resolved = try { (Resolve-Path -LiteralPath $targetPath -ErrorAction Stop).Path } catch { '' }
  if ($resolved -ne $repoPath) {
    throw "Refusing to overwrite existing skill at $targetPath. Remove or move it explicitly, then rerun."
  }
  Write-Output "`/ppt already points to $repoPath"
  exit 0
}

New-Item -ItemType Junction -Path $targetPath -Target $repoPath | Out-Null
Write-Output "Installed `/ppt at $targetPath"
