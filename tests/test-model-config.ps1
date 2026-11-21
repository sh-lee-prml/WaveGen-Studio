$ErrorActionPreference='Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/package-common.ps1')
$root=Join-Path (Split-Path -Parent $PSScriptRoot) ('test-output/hf-'+[Guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $root -Force|Out-Null
$checks=0
function Check([bool]$value,[string]$message){if(!$value){throw $message};$script:checks++}
function Fails([scriptblock]$action,[string]$message){$failed=$false;try{&$action|Out-Null}catch{$failed=$true};Check $failed $message}
function Clone([object]$value){return $value|ConvertTo-Json -Depth 20|ConvertFrom-Json}
$assets=@('flash','vspec','reuse')|ForEach-Object {[pscustomobject]@{id=$_;name=($_+'.zip');url='https://example.invalid/ignored.zip';sha256=('1'*64);size=3;files=[pscustomobject]@{"model/$_.onnx"=('2'*64)}}}
$configAssets=@($assets|ForEach-Object {$value=Clone $_;$value|Add-Member -NotePropertyName path -NotePropertyValue ('studio/v0.1.0-beta.1/'+$value.name);$value})
$config=[pscustomobject]@{model_type='wavegen';wavegen_studio=[pscustomobject]@{schema_version=1;releases=[pscustomobject]@{'0.1.0-beta.1'=[pscustomobject]@{assets=$configAssets}}}}
$manifest=[pscustomobject]@{version='0.1.0-beta.1';model_config=[pscustomobject]@{repository='LeeSangHoon/WaveGen';revision=('a'*40);url=('https://huggingface.co/LeeSangHoon/WaveGen/resolve/'+('a'*40)+'/config.json');sha256=''}}
function Set-Configuration([object]$value){
    $script:configurationBytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Depth 20))
    $hash=[Security.Cryptography.SHA256]::Create();try{$manifest.model_config.sha256=([BitConverter]::ToString($hash.ComputeHash($script:configurationBytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
$script:downloads=0;$script:corrupt=$false
function Get-VerifiedDownload([string]$Uri,[string]$Destination,[string]$Sha256){
    Check ($Uri -ceq $manifest.model_config.url) 'Unexpected configuration request URL'
    $script:downloads++
    [IO.File]::WriteAllBytes($Destination, $(if($script:corrupt){[byte[]]@(0)}else{$script:configurationBytes}))
}
Set-Configuration $config
$resolved=@(Resolve-ModelPackages -Manifest $manifest -PendingAssets $assets -CacheDirectory $root)
Check ($script:downloads-eq1-and$resolved.Count-eq3) 'Three pending models must share one genuine configuration download'
Check ($resolved[1].url-ceq('https://huggingface.co/LeeSangHoon/WaveGen/resolve/'+('a'*40)+'/studio/v0.1.0-beta.1/vspec.zip')) 'Artifact URL did not come from pinned configuration'
$null=Resolve-ModelPackages -Manifest $manifest -PendingAssets $assets -CacheDirectory $root
Check ($script:downloads-eq1) 'Verified cached configuration caused another download'
$null=Resolve-ModelPackages -Manifest $manifest -PendingAssets @() -CacheDirectory $root
Check ($script:downloads-eq1) 'No pending models caused a configuration download'
$old=Clone $manifest;$old.PSObject.Properties.Remove('model_config')
$legacy=@(Resolve-ModelPackages -Manifest $old -PendingAssets $assets -CacheDirectory $root)
Check ($legacy[0].url-ceq$assets[0].url) 'Legacy direct model URLs were not preserved'
$bad=Clone $manifest;$bad.model_config.sha256='f'*64;$script:corrupt=$true
Fails {Resolve-ModelPackages -Manifest $bad -PendingAssets $assets -CacheDirectory $root} 'Configuration SHA mismatch was accepted'
$script:corrupt=$false
$bad=Clone $manifest;$bad.version='9.9.9'
Fails {Resolve-ModelPackages -Manifest $bad -PendingAssets $assets -CacheDirectory $root} 'Missing release version was accepted'
$appUpdate = Clone $manifest
$appUpdate.version = '0.2.0-beta.1'
$appUpdate | Add-Member -NotePropertyName model_pack_version -NotePropertyValue $manifest.version
$updated = @(Resolve-ModelPackages -Manifest $appUpdate -PendingAssets $assets -CacheDirectory $root -Offline)
Check ($updated[0].url -ceq $resolved[0].url) 'App update could not reuse the original verified model release'
foreach($field in @('sha256','size','files','path')){
    $badConfig=Clone $config
    switch($field){
        'sha256' {$badConfig.wavegen_studio.releases.'0.1.0-beta.1'.assets[0].sha256='3'*64}
        'size' {$badConfig.wavegen_studio.releases.'0.1.0-beta.1'.assets[0].size=4}
        'files' {$badConfig.wavegen_studio.releases.'0.1.0-beta.1'.assets[0].files.'model/flash.onnx'='4'*64}
        'path' {$badConfig.wavegen_studio.releases.'0.1.0-beta.1'.assets[0].path='../flash.zip'}
    }
    Set-Configuration $badConfig
    Fails {Resolve-ModelPackages -Manifest $manifest -PendingAssets $assets -CacheDirectory $root} "Invalid model configuration $field binding was accepted"
}
Write-Host "Passed $checks Hugging Face model configuration checks; mock downloads only."
