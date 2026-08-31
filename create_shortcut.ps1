$targetDir = $PSScriptRoot
if (-not $targetDir) { $targetDir = (Get-Location).Path }

$regUserDesktop = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction SilentlyContinue).Desktop
if ($regUserDesktop) {
    $regUserDesktop = [System.Environment]::ExpandEnvironmentVariables($regUserDesktop)
}

$desktopPaths = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'OneDrive\Desktop'),
    $regUserDesktop
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

# Windows Explorer Shell Icon/Desktop Refresh
try {
    $code = @"
    [System.Runtime.InteropServices.DllImport("shell32.dll")]
    public static extern void SHChangeNotify(int wEventId, int uFlags, int dwItem1, int dwItem2);
"@
    $type = Add-Type -MemberDefinition $code -Name ShellNotification -Namespace Win32 -PassThru
    $type::SHChangeNotify(0x08000000, 0x0000, 0, 0) # SHCNE_ASSOCCHANGED
} catch {
    # Non-critical fallback
}
