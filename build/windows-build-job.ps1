param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-build-job.cs')
$code = [N7MBuildJob]::Run($settings.executable, [string[]]$settings.args, $settings.cwd, $settings.stdout, $settings.stderr, $settings.timeout, $settings.processMiB, $settings.jobMiB, $settings.cpuSeconds)
@{code=$code;assignedBeforeStart=$true;killDescendantsOnClose=$true;activeProcessLimit=64;processMiB=$settings.processMiB;jobMiB=$settings.jobMiB;cpuSeconds=$settings.cpuSeconds;wallMilliseconds=$settings.timeout} | ConvertTo-Json -Compress
