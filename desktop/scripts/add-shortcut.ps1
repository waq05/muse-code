# 为 dsc 桌面端创建桌面快捷方式（可重复运行：已存在则覆盖更新）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\add-shortcut.ps1
#   # 或指定目标 exe（默认 dist\win-unpacked\dsc.exe）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\add-shortcut.ps1 -TargetPath "D:\其他路径\dsc.exe"
param(
    [string]$TargetPath = (Join-Path $PSScriptRoot "..\dist\win-unpacked\dsc.exe")
)

$ErrorActionPreference = 'Stop'
$TargetPath = (Resolve-Path $TargetPath).Path

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'dsc.lnk'

$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = $TargetPath
$sc.WorkingDirectory = Split-Path $TargetPath -Parent
$sc.Description = 'dsc - 终端 AI harness 桌面端'
$sc.Save()

Write-Host "created: $lnk -> $TargetPath"
