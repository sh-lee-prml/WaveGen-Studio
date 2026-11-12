param(
    [string]$InstallDirectory = '',
    [string]$ReleaseTag = 'latest',
    [ValidateSet('flash','vspec','reuse')][string[]]$Models = @('flash','vspec','reuse'),
    [switch]$InstallVcRuntime,
    [string]$ManifestPath = '',
    [string]$CacheDirectory = ''
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'package-common.ps1')
if (!$InstallDirectory) { $InstallDirectory=Join-Path $env:LOCALAPPDATA 'WaveGen Studio' }
if (!$CacheDirectory) { $CacheDirectory=Join-Path $InstallDirectory 'downloads' }
if ($InstallVcRuntime) {
    New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null
    $redist=Join-Path $CacheDirectory 'vc_redist.x64.exe'
    Write-Host 'Downloading the Microsoft Visual C++ x64 runtime directly from Microsoft. Windows may request administrator permission.'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $redist
    $signature=Get-AuthenticodeSignature -LiteralPath $redist
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'Microsoft runtime signature verification failed.' }
    $process=Start-Process -FilePath $redist -ArgumentList '/install','/passive','/norestart' -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -notin @(0,1638,3010)) { throw "Microsoft runtime installer failed: $($process.ExitCode)" }
}
if (!(Test-Path -LiteralPath (Join-Path $env:SystemRoot 'System32/vcruntime140.dll'))) {
    Write-Warning 'Microsoft Visual C++ x64 runtime is required. Install it from https://aka.ms/vc14/vc_redist.x64.exe or rerun with -InstallVcRuntime. It is not mirrored in this release.'
}
$manifest=Get-ReleaseManifest -ReleaseTag $ReleaseTag -ManifestPath $ManifestPath -CacheDirectory $CacheDirectory
Install-VerifiedRelease -Manifest $manifest -InstallDirectory $InstallDirectory -CacheDirectory $CacheDirectory -Models $Models -Offline:([bool]$ManifestPath)
