param(
    [string]$InstallDirectory = '',
    [string]$ReleaseTag = 'latest',
    [ValidateSet('flash','vspec','reuse')][string[]]$Models = @('flash','vspec','reuse'),
    [switch]$InstallVcRuntime,
    [string]$ManifestPath = '',
    [string]$CacheDirectory = ''
)
$ErrorActionPreference='Stop'
if (!$InstallDirectory) {
    $parent=Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $parent '.studio-install.json')) { $InstallDirectory=$parent }
    else { $InstallDirectory=Join-Path $env:LOCALAPPDATA 'WaveGen Studio' }
}
if (!(Test-Path -LiteralPath (Join-Path $InstallDirectory '.studio-install.json'))) { throw 'No managed installation found. Run install.ps1 first or pass -InstallDirectory.' }
& (Join-Path $PSScriptRoot 'install.ps1') -InstallDirectory $InstallDirectory -ReleaseTag $ReleaseTag -Models $Models -InstallVcRuntime:$InstallVcRuntime -ManifestPath $ManifestPath -CacheDirectory $CacheDirectory
