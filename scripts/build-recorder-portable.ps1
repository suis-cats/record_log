param([string]$OutputRoot = (Join-Path $PSScriptRoot '..\release'))
$ErrorActionPreference = 'Stop'
$projectPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$release = [IO.Path]::GetFullPath($OutputRoot)
$stage = Join-Path $release 'ResearchRecorder-Windows-x64'
$zip = Join-Path $release 'ResearchRecorder-Windows-x64.zip'
if (-not $release.StartsWith($project, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputRoot must stay inside the project directory.' }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item -Path (Join-Path $project 'node_modules\electron\dist\*') -Destination $stage -Recurse -Force
Rename-Item -LiteralPath (Join-Path $stage 'electron.exe') -NewName 'ResearchRecorder.exe'
$app = Join-Path $stage 'resources\app'
New-Item -ItemType Directory -Path $app | Out-Null
@'
{
  "name": "research-recorder",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "recorder-electron.mjs"
}
'@ | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding utf8
foreach ($name in @('recorder-electron.mjs','recorder-preload.cjs','research-recorder-core.mjs','raw-study.mjs')) {
  Copy-Item -LiteralPath (Join-Path $project $name) -Destination $app
}
Copy-Item -LiteralPath (Join-Path $project 'dist') -Destination $app -Recurse
New-Item -ItemType Directory -Path (Join-Path $app 'node_modules\ffmpeg-static') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'node_modules\ffmpeg-static\ffmpeg.exe') -Destination (Join-Path $app 'node_modules\ffmpeg-static\ffmpeg.exe')
New-Item -ItemType Directory -Path (Join-Path $app 'node_modules\ffprobe-static\bin\win32\x64') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe') -Destination (Join-Path $app 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe')
New-Item -ItemType Directory -Path (Join-Path $app 'bin') -Force | Out-Null
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$collector = Join-Path $app 'bin\input-collector.exe'
& $compiler /nologo /optimize+ /target:exe "/out:$collector" (Join-Path $project 'portable\InputCollector.cs')
if ($LASTEXITCODE -ne 0) { throw "Input collector compilation failed: $LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $project 'portable\README.txt') -Destination (Join-Path $stage 'はじめに.txt')
Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
@{ path=$zip; sha256=$hash; bytes=(Get-Item -LiteralPath $zip).Length } | ConvertTo-Json
