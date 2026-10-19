# Rebuild the demo workspace from sandbox/template: a clean copy of the project with no leases.
# PowerShell twin of reset.sh, for Windows without Git Bash on PATH.
#
# The workspace lives OUTSIDE this repository on purpose: Claude Code treats a directory loaded with
# --plugin-dir as a protected path and refuses edits inside it.
#
#   .\sandbox\reset.ps1                       (default: ~\agent-stoplight-sandbox)
#   .\sandbox\reset.ps1 -Destination D:\tmp\sb
#
# The directory is emptied, not removed, so a terminal still sitting in it doesn't break the reset.
param([string]$Destination = (Join-Path $HOME 'agent-stoplight-sandbox'))

$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot 'template'
New-Item -ItemType Directory -Force $Destination | Out-Null
Get-ChildItem -Force $Destination | Remove-Item -Recurse -Force
Copy-Item -Recurse -Force (Join-Path $template '*') $Destination
Write-Output $Destination
