param([string]$DependencyDirectory = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (!$DependencyDirectory) { $DependencyDirectory = Join-Path $repoRoot 'third_party/sdk' }
. (Join-Path $PSScriptRoot 'package-common.ps1')
New-Item -ItemType Directory -Path $DependencyDirectory -Force | Out-Null
$toolchain = 'llvm-mingw-20261104-ucrt-x86_64'
$archive = Join-Path $DependencyDirectory "$toolchain.zip"
Get-VerifiedDownload -Uri "https://github.com/mstorsjo/llvm-mingw/releases/download/20261104/$toolchain.zip" -Destination $archive -Sha256 '552191b5754c49a5a20723276a6fc56541ea1922c4c50b7b669022333fc1b40f'
Expand-SafeZip -Archive $archive -Destination $DependencyDirectory -AllowExisting
if (!(Test-Path -LiteralPath (Join-Path $DependencyDirectory "$toolchain/bin/clang++.exe"))) { throw 'Compiler missing from LLVM-MinGW archive.' }

$package = 'microsoft.ml.onnxruntime.gpu.windows'
$version = '1.31.1'
$name = "$package.$version.nupkg"
$archive = Join-Path $DependencyDirectory $name
Get-VerifiedDownload -Uri "https://api.nuget.org/v3-flatcontainer/$package/$version/$name" -Destination $archive -Sha256 '9c9c7c951b9e76036b5e90d2a519359969d717d1c16dfc718c808afb42d778b1'
$sdk = Join-Path $DependencyDirectory "onnxruntime-build-$version"
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    # Compile against the C/C++ API. The core DLL is used only by the CPU storage test.
    $entries = [ordered]@{
        'runtimes/win-x64/native/onnxruntime.lib' = 'lib/onnxruntime.lib'
        'runtimes/win-x64/native/onnxruntime.dll' = 'lib/onnxruntime.dll'
    }
    foreach ($entry in $zip.Entries) {
        if ($entry.FullName -cmatch '^buildTransitive/native/include/([A-Za-z0-9_]+\.(?:h|inc))$') {
            $entries[$entry.FullName] = "include/$($Matches[1])"
        }
    }
    foreach ($item in $entries.GetEnumerator()) {
        $target = Get-SafeChild $sdk $item.Value
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($item.Key), $target, $true)
    }
} finally {
    $zip.Dispose()
}
Write-Host 'Build dependencies are ready. No GPU driver or system-wide software was installed.'
