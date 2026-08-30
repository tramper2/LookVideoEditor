$targetDir = $PSScriptRoot
if (-not $targetDir) { $targetDir = (Get-Location).Path }
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "LookVideoEditor.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = Join-Path $targetDir "start.bat"
$s.WorkingDirectory = $targetDir
$icoPath = Join-Path $targetDir "app.ico"
if (Test-Path $icoPath) {
    $s.IconLocation = "$icoPath,0"
}
$s.Description = "LookVideoEditor - Local Video Studio"
$s.Save()
Write-Host "[SUCCESS] Desktop shortcut created at: $shortcutPath"
