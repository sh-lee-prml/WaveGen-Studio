param([string]$ToolchainDirectory='',[string]$OnnxRuntimeDirectory='')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(!$ToolchainDirectory){$ToolchainDirectory=Join-Path $root 'third_party/sdk/llvm-mingw-20261104-ucrt-x86_64'}
if(!$OnnxRuntimeDirectory){$OnnxRuntimeDirectory=Join-Path $root 'third_party/sdk/onnxruntime-win-x64-gpu_cuda12-1.31.1'}
if(!(Test-Path -LiteralPath (Join-Path $root 'build/generated/version.h'))){throw 'Run scripts/build.ps1 first.'}
$output=Join-Path $root 'build/tests';New-Item -ItemType Directory -Force -Path $output|Out-Null
& (Join-Path $ToolchainDirectory 'bin/clang++.exe') --target=x86_64-w64-windows-gnu -std=c++17 -O2 -ffp-contract=off -Wno-macro-redefined -static (Join-Path $root 'tests/test-store.cpp') "-I$(Join-Path $root 'build/generated')" "-I$(Join-Path $OnnxRuntimeDirectory 'include')" (Join-Path $OnnxRuntimeDirectory 'lib/onnxruntime.lib') -lws2_32 -lbcrypt -lshell32 -luser32 -o (Join-Path $output 'test-store.exe')
if($LASTEXITCODE-ne0){throw 'Native test compile failed'}
Copy-Item -LiteralPath (Join-Path $OnnxRuntimeDirectory 'lib/onnxruntime.dll') -Destination $output -Force
& (Join-Path $output 'test-store.exe') $root
if($LASTEXITCODE-ne0){throw 'Native CPU Store test failed'}
