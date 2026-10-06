<#
  在桌面创建「MC 标语墙」快捷方式，双击即可打开网页版。

  用法（右键 → 使用 PowerShell 运行，或在终端里执行）：
    powershell -ExecutionPolicy Bypass -File tools\create-shortcut.ps1
    powershell -ExecutionPolicy Bypass -File tools\create-shortcut.ps1 -Name "标语墙" -NoDesktop

  参数：
    -Name       快捷方式名称，默认 "MC 标语墙"
    -Location   放到哪个目录，默认桌面
    -NoDesktop  只放在项目根目录，不放到桌面
#>
param(
  [string]$Name = "MC 标语墙",
  [string]$Location = [Environment]::GetFolderPath('Desktop'),
  [switch]$NoDesktop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'start.cmd'
$icon = Join-Path $root 'assets\icon.ico'

if (-not (Test-Path $target)) { throw "找不到 $target" }

# 没有图标就先尝试生成（需要 Node）
if (-not (Test-Path $icon)) {
  Write-Host "图标不存在，尝试生成…"
  try { & node (Join-Path $root 'tools\make-icon.mjs') | Out-Null } catch { Write-Warning "图标生成失败，将使用系统默认图标" }
}

function New-Shortcut([string]$dir) {
  if (-not (Test-Path $dir)) { return $null }
  $path = Join-Path $dir "$Name.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = $target
  $lnk.WorkingDirectory = $root
  $lnk.Description = "Minecraft 标语墙投影生成器"
  if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
  return $path
}

$made = @()
if (-not $NoDesktop -and $Location) { $made += New-Shortcut $Location }
$made += New-Shortcut $root

foreach ($p in $made) { if ($p) { Write-Host "已创建快捷方式：$p" } }
if ($made.Count -eq 0) { Write-Warning "没有创建任何快捷方式" }
