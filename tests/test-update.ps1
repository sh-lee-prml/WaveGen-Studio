$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/package-common.ps1')
$caseRoot=Join-Path (Split-Path -Parent $PSScriptRoot) ('test-output/u'+[Guid]::NewGuid().ToString('N').Substring(0,6))
$cache=Join-Path $caseRoot 'cache';$installation=Join-Path $caseRoot 'app'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$checks=0
function Check([bool]$Value,[string]$Message){if(!$Value){throw $Message};$script:checks++}
function New-Release([string]$Version,[hashtable]$AppFiles){
    $assets=@()
    foreach($id in @('app','runtime','flash')){
        $dir=Join-Path $caseRoot ($Version+'-'+$id);New-Item -ItemType Directory -Force -Path $dir|Out-Null
        $contents=if($id-eq'app'){$AppFiles}elseif($id-eq'runtime'){@{'runtime.txt'='runtime'}}else{@{'model/test.bin'='model'}}
        $hashes=@{}
        foreach($name in $contents.Keys){$p=Get-SafeChild $dir $name;New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p)|Out-Null;[IO.File]::WriteAllText($p,$contents[$name]);$hashes[$name]=Get-FileDigest $p}
        $archive=Join-Path $cache ($Version+'-'+$id+'.zip');[IO.Compression.ZipFile]::CreateFromDirectory($dir,$archive)
        $assets+=[pscustomobject]@{id=$id;name=(Split-Path -Leaf $archive);url='https://example.invalid/not-used';sha256=(Get-FileDigest $archive);size=(Get-Item $archive).Length;required=$true;files=[pscustomobject]$hashes}
    }
    return [pscustomobject]@{schema_version=1;version=$Version;repository='sh-lee-prml/WaveGen-Studio';assets=$assets}
}
function Apply([object]$Manifest){Install-VerifiedRelease -Manifest $Manifest -InstallDirectory $installation -CacheDirectory $cache -Models flash -Offline}
function Must-Fail([scriptblock]$Action,[string]$Message){$failed=$false;try{&$Action}catch{$failed=$true};Check $failed $Message}
$one=New-Release '0.1.0-beta.1' @{'first.txt'='old';'obsolete.txt'='retire me';'second.txt'='second old'}
Must-Fail {Install-VerifiedRelease -Manifest $one -InstallDirectory (Join-Path $caseRoot ('x'*129)) -CacheDirectory $cache -Models flash -Offline} 'Excessive installation path was accepted'
Apply $one
Check ((Get-Content -Raw (Join-Path $installation 'first.txt'))-eq'old') 'Fresh offline installation failed'
New-Item -ItemType Directory -Force -Path (Join-Path $installation 'data/voices')|Out-Null
[IO.File]::WriteAllText((Join-Path $installation 'data/voices/private.json'),'private voice sentinel')
[IO.File]::WriteAllText((Join-Path $installation 'user-note.txt'),'keep unrelated file')
$privateHash=Get-FileDigest (Join-Path $installation 'data/voices/private.json')
$two=New-Release '0.1.0-beta.2' @{'first.txt'='new';'second.txt'='second new'}
Apply $two
Check ((Get-FileDigest (Join-Path $installation 'data/voices/private.json'))-eq$privateHash) 'Update changed user data'
Check ((Get-Content -Raw (Join-Path $installation 'user-note.txt'))-eq'keep unrelated file') 'Update removed an unmanaged file'
Check (!(Test-Path (Join-Path $installation 'obsolete.txt'))) 'Retired managed file was not removed'
Check (@(Get-ChildItem -LiteralPath (Join-Path $installation 'backups') -Recurse -Filter obsolete.txt).Count-eq1) 'Retired file was not backed up'
$appOnly=New-Release '0.1.0-beta.21' @{'first.txt'='new';'second.txt'='second new';'version.txt'='app-only update'}
$appOnly|Add-Member -NotePropertyName model_config -NotePropertyValue ([pscustomobject]@{repository='LeeSangHoon/WaveGen';revision=('a'*40);url='https://huggingface.co/LeeSangHoon/WaveGen/resolve/'+('a'*40)+'/config.json';sha256=('f'*64)})
foreach($asset in $appOnly.assets|Where-Object {$_.id-ne'app'}){
    Remove-Item -LiteralPath (Join-Path $cache $asset.name)
    $asset.name='renamed-no-cache-'+$asset.name
}
Apply $appOnly
Check ((Get-Content -Raw (Join-Path $installation 'version.txt'))-eq'app-only update') 'App-only update failed when unchanged model/runtime archives were absent'
Check ((Get-Content -Raw (Join-Path $installation 'model/test.bin'))-eq'model') 'App-only update changed the model'
Check (!(Test-Path -LiteralPath (Join-Path $cache ('model-config-'+('f'*64)+'.json')))) 'Unchanged installed models unnecessarily downloaded a configuration'
$appManifest = Join-Path $caseRoot 'app-update.json'
$appOnly | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $appManifest -Encoding utf8
& (Join-Path $PSScriptRoot '../scripts/update.ps1') -InstallDirectory $installation -ManifestPath $appManifest -CacheDirectory $cache
$installed = Get-Content -Raw (Join-Path $installation '.studio-install.json') | ConvertFrom-Json
Check (@($installed.assets | Where-Object { $_.id -in @('vspec','reuse') }).Count -eq 0) 'A Flash-only update added an optional model'
$snapshot=Get-FileDigest (Join-Path $installation 'first.txt')
$bad=($two|ConvertTo-Json -Depth 20|ConvertFrom-Json);$bad.assets[0].sha256='0'*64;$bad.assets[0].files.'first.txt'='0'*64
Must-Fail {Apply $bad} 'Invalid archive checksum was accepted'
Check ((Get-FileDigest (Join-Path $installation 'first.txt'))-eq$snapshot) 'Failed verification changed installed files'
$bad=New-Release '0.1.0-beta.3' @{'data/voices/private.json'='destroy'}
Must-Fail {Apply $bad} 'A package was allowed to write data/'
$bad=($two|ConvertTo-Json -Depth 20|ConvertFrom-Json);$bad.assets[0].files|Add-Member -NotePropertyName '../outside.txt' -NotePropertyValue ('0'*64)
Must-Fail {Apply $bad} 'Path traversal was accepted'
$zip=Join-Path $caseRoot 'traversal.zip';$stream=[IO.File]::Open($zip,[IO.FileMode]::Create);$archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
$entry=$archive.CreateEntry('../outside.txt');$writer=[IO.StreamWriter]::new($entry.Open());$writer.Write('bad');$writer.Dispose();$archive.Dispose();$stream.Dispose()
Must-Fail {Expand-SafeZip -Archive $zip -Destination (Join-Path $caseRoot 'bad-expand')} 'ZIP traversal was accepted'
# Override just the filesystem copy command to inject one mid-commit I/O error.
# Production installer has no test bypass or fault flag.
$three=New-Release '0.1.0-beta.4' @{'first.txt'='third';'second.txt'='third second'}
$script:inject=$true;$script:copies=0
function Copy-Item {
    param([string]$LiteralPath,[string]$Destination,[switch]$Force)
    if($Destination.StartsWith($installation+[IO.Path]::DirectorySeparatorChar) -and !$Destination.Contains('backups') -and $script:inject){$script:copies++;if($script:copies-eq2){$script:inject=$false;throw 'Injected write failure'}}
    Microsoft.PowerShell.Management\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
Must-Fail {Apply $three} 'Injected commit error did not fail'
Remove-Item Function:\Copy-Item
Check ((Get-Content -Raw (Join-Path $installation 'first.txt'))-eq'new' -and (Get-Content -Raw (Join-Path $installation 'second.txt'))-eq'second new') 'Failed commit was not rolled back'
Check ((Get-FileDigest (Join-Path $installation 'data/voices/private.json'))-eq$privateHash) 'Rollback touched private data'
Write-Host "Passed $checks installer/update checks; offline synthetic archives only."
