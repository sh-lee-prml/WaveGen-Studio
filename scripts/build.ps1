param(
    [string]$ToolchainDirectory = '',
    [string]$OnnxRuntimeDirectory = '',
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (!$ToolchainDirectory) { $ToolchainDirectory = Join-Path $repoRoot 'third_party/sdk/llvm-mingw-20261104-ucrt-x86_64' }
if (!$OnnxRuntimeDirectory) { $OnnxRuntimeDirectory = Join-Path $repoRoot 'third_party/sdk/onnxruntime-win-x64-gpu_cuda12-1.31.1' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'build/app' }
$compiler = Join-Path $ToolchainDirectory 'bin/clang++.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Compiler missing. Run scripts/bootstrap-build.ps1 or pass -ToolchainDirectory.' }
if (!(Test-Path -LiteralPath (Join-Path $OnnxRuntimeDirectory 'include/onnxruntime_cxx_api.h'))) { throw 'ONNX Runtime SDK missing. Run scripts/bootstrap-build.ps1 or pass -OnnxRuntimeDirectory.' }
$version = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'version.json') | ConvertFrom-Json
if ($version.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$' -or $version.display_version -notmatch '^[A-Za-z0-9.() -]+$') { throw 'Unsafe version metadata.' }
$generated = Join-Path $repoRoot 'build/generated'
New-Item -ItemType Directory -Force -Path $generated,$OutputDirectory | Out-Null
$header = "#pragma once`n#define WAVEGEN_STUDIO_VERSION `"$($version.version)`"`n#define WAVEGEN_STUDIO_DISPLAY_VERSION `"$($version.display_version)`"`n"
[IO.File]::WriteAllText((Join-Path $generated 'version.h'), $header, [Text.UTF8Encoding]::new($false))
$native = Join-Path $repoRoot 'native'
& $compiler --target=x86_64-w64-windows-gnu -std=c++17 -O2 -ffp-contract=off -Wno-macro-redefined -static -municode -mwindows "-ffile-prefix-map=$repoRoot=." "-fmacro-prefix-map=$repoRoot=." "-fdebug-prefix-map=$repoRoot=." "-ffile-prefix-map=$ToolchainDirectory=third_party/sdk/toolchain" "-fmacro-prefix-map=$ToolchainDirectory=third_party/sdk/toolchain" "-ffile-prefix-map=$OnnxRuntimeDirectory=third_party/sdk/onnxruntime" "-fmacro-prefix-map=$OnnxRuntimeDirectory=third_party/sdk/onnxruntime" (Join-Path $native 'studio_main.cpp') "-I$generated" "-I$(Join-Path $OnnxRuntimeDirectory 'include')" (Join-Path $OnnxRuntimeDirectory 'lib/onnxruntime.lib') -lws2_32 -lbcrypt -lshell32 -luser32 -o (Join-Path $OutputDirectory 'WaveGen Studio.exe')
if ($LASTEXITCODE -ne 0) { throw "C++ build failed: $LASTEXITCODE" }
# Only curated runtime assets, never data, examples or development outputs.
function Copy-CuratedTree([string]$Source,[string]$Destination) {
    $sourceRoot = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\','/')
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File) {
        $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\','/')
        $target = Join-Path $Destination $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}
Copy-CuratedTree (Join-Path $repoRoot 'web') (Join-Path $OutputDirectory 'studio_web')
Copy-CuratedTree (Join-Path $repoRoot 'presets') (Join-Path $OutputDirectory 'presets')
foreach ($name in @('version.json','LICENSE','THIRD_PARTY_NOTICES.md','README.md','README_KO.md','CONTRIBUTING.md','Install-WaveGen-Studio.cmd','Update-WaveGen-Studio.cmd','Launch-WaveGen-Studio.cmd')) {
    $file = Join-Path $repoRoot $name
    if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination $OutputDirectory -Force }
}
foreach ($name in @('licenses','docs','scripts')) {
    $directory = Join-Path $repoRoot $name
    if (Test-Path -LiteralPath $directory) { Copy-CuratedTree $directory (Join-Path $OutputDirectory $name) }
}
$record = [ordered]@{version=$version.version; display_version=$version.display_version; compiler='llvm-mingw-20261104-ucrt-x86_64'; onnxruntime='1.31.1-cuda12'; binary_sha256=(Get-FileHash -LiteralPath (Join-Path $OutputDirectory 'WaveGen Studio.exe') -Algorithm SHA256).Hash.ToLower(); python_runtime_required=$false}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-info.json') -Encoding UTF8
Write-Host "Built $OutputDirectory"
Write-Host 'Runtime DLLs and exported models are separate. Use install.ps1 or copy your verified runtime/model packs before launch.'
