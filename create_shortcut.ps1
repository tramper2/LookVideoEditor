$targetDir = $PSScriptRoot
if (-not $targetDir) { $targetDir = (Get-Location).Path }

$desktopPaths = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'OneDrive\Desktop')
) | Select-Object -Unique | Where-Object { $_ -and (Test-Path $_) }

$ws = New-Object -ComObject WScript.Shell
$icoPath = Join-Path $targetDir 'nanobanana.ico'

foreach ($desktop in $desktopPaths) {
    $shortcutPath = Join-Path $desktop 'LookVideoEditor.lnk'
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force -ErrorAction SilentlyContinue
    }
    $s = $ws.CreateShortcut($shortcutPath)
    $s.TargetPath = Join-Path $targetDir 'start.bat'
    $s.WorkingDirectory = $targetDir
    if (Test-Path $icoPath) {
        $s.IconLocation = "$icoPath,0"
    }
    $s.Description = 'LookVideoEditor - Local Video Studio'
    $s.Save()
    Write-Host "[SUCCESS] Shortcut created with nanobanana.ico at: $shortcutPath"
}
