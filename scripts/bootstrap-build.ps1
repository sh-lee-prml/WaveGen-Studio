param([string]$DependencyDirectory = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (!$DependencyDirectory) { $DependencyDirectory = Join-Path $repoRoot 'third_party/sdk' }
. (Join-Path $PSScriptRoot 'package-common.ps1')
$dependencies = @(
    @{name='llvm-mingw-20261104-ucrt-x86_64'; file='llvm-mingw-20261104-ucrt-x86_64.zip'; sha256='552191b5754c49a5a20723276a6fc56541ea1922c4c50b7b669022333fc1b40f'; url='https://github.com/mstorsjo/llvm-mingw/releases/download/20261104/llvm-mingw-20261104-ucrt-x86_64.zip'},
    @{name='onnxruntime-win-x64-gpu_cuda12-1.31.1'; file='onnxruntime-win-x64-gpu_cuda12-1.31.1.zip'; sha256='5cbf65edc93dc7bb3296249b1b6e1b2228e575902af64d6163d0da2103cef9d5'; url='https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-win-x64-gpu_cuda12-1.31.1.zip'}
)
New-Item -ItemType Directory -Path $DependencyDirectory -Force | Out-Null
foreach ($dependency in $dependencies) {
    $archive = Join-Path $DependencyDirectory $dependency.file
    Get-VerifiedDownload -Uri $dependency.url -Destination $archive -Sha256 $dependency.sha256
    Expand-SafeZip -Archive $archive -Destination $DependencyDirectory -AllowExisting
    if (!(Test-Path -LiteralPath (Join-Path $DependencyDirectory $dependency.name))) { throw "SDK archive did not provide $($dependency.name)" }
}
Write-Host 'Build dependencies are ready. No GPU driver or system-wide software was installed.'
