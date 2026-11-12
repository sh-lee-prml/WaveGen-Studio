# Shared installer primitives. No app process is stopped and data/ is never written.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-FileDigest([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SafeChild([string]$Root,[string]$Relative,[switch]$ProtectUserData) {
    $name = $Relative.Replace('\','/')
    if (!$name -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Contains([char]0)) { throw "Unsafe package path: $Relative" }
    $parts = $name.Split('/')
    if (@($parts | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' -or $_.EndsWith(' ') -or $_.EndsWith('.') }).Count) { throw "Unsafe package path: $Relative" }
    if ($ProtectUserData -and $parts[0] -match '^(?i:data|backups|downloads|\.update-staging.*)$') { throw "Package attempts to modify protected user storage: $Relative" }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    $target = [IO.Path]::GetFullPath((Join-Path $base $name))
    if (!$target.StartsWith($base+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes destination: $Relative" }
    $ancestor = $target
    while ($ancestor.Length -ge $base.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            if ((Get-Item -Force -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Junction/symlink destinations are unsupported: $ancestor" }
        }
        $ancestor = Split-Path -Parent $ancestor
        if (!$ancestor) { break }
    }
    return $target
}

function Get-VerifiedDownload([string]$Uri,[string]$Destination,[string]$Sha256) {
    if ($Sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Missing or invalid package checksum.' }
    if ((Test-Path -LiteralPath $Destination) -and (Get-FileDigest $Destination) -eq $Sha256.ToLowerInvariant()) { return }
    $address = [Uri]$Uri
    if ($address.Scheme -ne 'https') { throw 'Downloads require HTTPS.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    $partial = $Destination+'.partial'
    $curl = Join-Path $env:SystemRoot 'System32/curl.exe'
    Write-Host "Downloading $($address.AbsolutePath.Split('/')[-1])"
    if (Test-Path -LiteralPath $curl) {
        & $curl --fail --location --retry 3 --continue-at - --output $partial $Uri
        if ($LASTEXITCODE -ne 0) { throw 'Download failed. Re-run to resume the .partial download.' }
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $partial
    }
    if ((Get-FileDigest $partial) -ne $Sha256.ToLowerInvariant()) { throw "SHA256 mismatch: $partial. Do not run this file. Remove that partial file before retrying." }
    Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Expand-SafeZip([string]$Archive,[string]$Destination,[switch]$AllowExisting,[switch]$ProtectUserData) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $seen = @{}; [long]$total = 0
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Archive symlinks are unsupported.' }
            $target = Get-SafeChild $Destination $entry.FullName -ProtectUserData:$ProtectUserData
            if ($seen.ContainsKey($target)) { throw "Duplicate archive entry: $($entry.FullName)" }
            $seen[$target] = $true; $total += $entry.Length
            if ($total -gt 12GB -or $seen.Count -gt 30000) { throw 'Archive exceeds the installer safety bound.' }
            if (!$AllowExisting -and (Test-Path -LiteralPath $target)) { throw "Unexpected existing staged file: $target" }
        }
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $target = Get-SafeChild $Destination $entry.FullName -ProtectUserData:$ProtectUserData
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true)
        }
    } finally { $zip.Dispose() }
}

function Assert-AppClosed([string]$InstallDirectory) {
    $executable = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'WaveGen Studio.exe'))
    foreach ($process in @(Get-Process -Name 'WaveGen Studio' -ErrorAction SilentlyContinue)) {
        try { $path = $process.Path } catch { throw 'Cannot confirm whether Studio is running. Close Studio before updating.' }
        if (!$path -or [string]::Equals($path,$executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Studio is running. Use Quit app, then run this update again. Closing only the browser tab is not enough.' }
    }
}

function Get-ReleaseManifest([string]$ReleaseTag,[string]$ManifestPath,[string]$CacheDirectory) {
    if ($ManifestPath) { return Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json }
    $repository = 'sh-lee-prml/WaveGen-Studio'
    if (!$ReleaseTag -or $ReleaseTag -eq 'latest') {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases" -Headers @{'User-Agent'='WaveGen-Studio-Installer';Accept='application/vnd.github+json'}
        $release = @($releases | Where-Object { !$_.draft }) | Select-Object -First 1
        if (!$release) { throw 'No published release was found.' }
        $ReleaseTag = $release.tag_name
    }
    if ($ReleaseTag -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$') { throw 'Invalid release tag.' }
    $uri = "https://github.com/$repository/releases/download/$ReleaseTag/manifest.json"
    Write-Host "Reading release $ReleaseTag from $repository"
    # HTTPS protects transport. SHA256 checksums verify file integrity, not a
    # publisher signature. The manifest itself is trusted as a release asset.
    return Invoke-RestMethod -Uri $uri -Headers @{'User-Agent'='WaveGen-Studio-Installer'}
}

function Resolve-ModelPackages {
    param([object]$Manifest,[object[]]$PendingAssets,[string]$CacheDirectory,[switch]$Offline)
    $modelAssets=@($PendingAssets|Where-Object {$_.id -in @('flash','vspec','reuse')})
    if (!$modelAssets.Count -or !$Manifest.PSObject.Properties['model_config']) { return $PendingAssets }
    $descriptor=$Manifest.model_config
    if ($descriptor.repository -cne 'LeeSangHoon/WaveGen' -or $descriptor.revision -cnotmatch '^[a-f0-9]{40}$' -or $descriptor.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid pinned Hugging Face model configuration descriptor.' }
    $prefix="https://huggingface.co/$($descriptor.repository)/resolve/$($descriptor.revision)/"
    if ($descriptor.url -cne ($prefix+'config.json')) { throw 'Model configuration URL does not match its pinned Hugging Face repository/revision.' }
    $configuration=Join-Path $CacheDirectory ('model-config-'+$descriptor.sha256+'.json')
    $verified=(Test-Path -LiteralPath $configuration -PathType Leaf) -and (Get-FileDigest $configuration) -eq $descriptor.sha256
    if (!$verified) {
        if ($Offline) { throw 'The pinned Hugging Face model configuration is missing from the offline cache or has an invalid SHA256.' }
        # This is a genuine configuration download: its versioned artifact
        # entries determine the model URLs below. No count-only request occurs.
        Get-VerifiedDownload -Uri $descriptor.url -Destination $configuration -Sha256 $descriptor.sha256
    }
    if ((Get-FileDigest $configuration) -ne $descriptor.sha256) { throw 'Hugging Face model configuration SHA256 mismatch.' }
    if ((Get-Item -LiteralPath $configuration).Length -gt 4MB) { throw 'Model configuration exceeds its size limit.' }
    $document=Get-Content -Raw -LiteralPath $configuration|ConvertFrom-Json
    if (!$document.PSObject.Properties['wavegen_studio'] -or $document.wavegen_studio.schema_version -ne 1) { throw 'Unsupported Hugging Face Studio model configuration schema.' }
    $releaseProperty=$document.wavegen_studio.releases.PSObject.Properties[$Manifest.version]
    if (!$releaseProperty) { throw 'The Hugging Face model configuration does not contain this Studio release.' }
    $configured=@{}
    foreach ($asset in @($releaseProperty.Value.assets)) {
        if ($asset.id -notin @('flash','vspec','reuse') -or $configured.ContainsKey($asset.id)) { throw 'Unknown or duplicate configured model component.' }
        $configured[$asset.id]=$asset
    }
    $resolved=@()
    foreach ($asset in $PendingAssets) {
        if ($asset.id -notin @('flash','vspec','reuse')) { $resolved+=$asset;continue }
        if (!$configured.ContainsKey($asset.id)) { throw "Hugging Face model configuration is missing component: $($asset.id)" }
        $actual=$configured[$asset.id]
        if ($actual.name -cne $asset.name -or $actual.sha256 -cne $asset.sha256 -or [long]$actual.size -ne [long]$asset.size) { throw "Hugging Face model artifact differs from the release manifest: $($asset.id)" }
        $expectedFiles=@($asset.files.PSObject.Properties);$actualFiles=@($actual.files.PSObject.Properties)
        if ($expectedFiles.Count -ne $actualFiles.Count) { throw "Hugging Face model file list differs from the release manifest: $($asset.id)" }
        foreach ($file in $expectedFiles) {
            $property=$actual.files.PSObject.Properties[$file.Name]
            if (!$property -or $property.Value -cne $file.Value) { throw "Hugging Face model file checksum differs from the release manifest: $($asset.id)" }
        }
        if ($actual.path -cnotmatch '^[A-Za-z0-9._/-]+\.zip$') { throw 'Invalid Hugging Face model artifact path.' }
        [void](Get-SafeChild $CacheDirectory $actual.path)
        if (($actual.path.Split('/')[-1]) -cne $actual.name) { throw 'Hugging Face model artifact filename does not match its path.' }
        $resolved+=[pscustomobject]@{id=$actual.id;name=$actual.name;url=($prefix+$actual.path);sha256=$actual.sha256;size=$actual.size;files=$actual.files}
    }
    return $resolved
}

function Install-VerifiedRelease {
    param([object]$Manifest,[string]$InstallDirectory,[string]$CacheDirectory,[string[]]$Models=@('flash','vspec','reuse'),[switch]$Offline)
    if ($Manifest.schema_version -ne 1 -or $Manifest.repository -ne 'sh-lee-prml/WaveGen-Studio') { throw 'Unexpected release manifest identity/schema.' }
    if ($Manifest.version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?$') { throw 'Invalid release version.' }
    $target = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\','/')
    if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\','/')) { throw 'Choose an application folder, not a drive root.' }
    if ($target.Length -gt 128) { throw 'Installation path is too long. Choose a folder with at most 128 characters, such as C:\Apps\WaveGen Studio, so voice files and backups fit Windows path limits.' }
    Assert-AppClosed $target
    New-Item -ItemType Directory -Force -Path $target,$CacheDirectory | Out-Null
    $ids=@{}; $assets=@(); $incoming=@{}
    foreach ($asset in $Manifest.assets) {
        if ($asset.id -notin @('app','runtime','flash','vspec','reuse') -or $ids.ContainsKey($asset.id)) { throw 'Unknown or duplicate package component.' }
        $ids[$asset.id]=$true
        if (!$asset.required -and $asset.id -notin $Models) { continue }
        if ($asset.name -notmatch '^[A-Za-z0-9._-]+\.zip$') { throw 'Unsafe archive name.' }
        $assets += $asset
        foreach ($property in $asset.files.PSObject.Properties) {
            $relative=$property.Name; $digest=[string]$property.Value
            [void](Get-SafeChild $target $relative -ProtectUserData)
            if ($relative -eq '.studio-install.json' -or $digest -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid managed-file metadata.' }
            if ($incoming.ContainsKey($relative) -and $incoming[$relative] -ne $digest) { throw "Conflicting package contents: $relative" }
            $incoming[$relative]=$digest.ToLowerInvariant()
        }
    }
    foreach ($id in @('app','runtime','flash')) { if ($id -notin @($assets | ForEach-Object {$_.id})) { throw "Required package missing: $id" } }
    foreach ($id in $Models) { if ($id -notin @($assets | ForEach-Object {$_.id})) { throw "Selected model is unavailable in this release: $id" } }
    $statePath=Join-Path $target '.studio-install.json'; $oldAssets=@()
    if (Test-Path -LiteralPath $statePath) { $old=Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json; $oldAssets=@($old.assets) }
    elseif (Test-Path -LiteralPath (Join-Path $target 'WaveGen Studio.exe')) {
        if (!$incoming.ContainsKey('WaveGen Studio.exe') -or (Get-FileDigest (Join-Path $target 'WaveGen Studio.exe')) -ne $incoming['WaveGen Studio.exe']) { throw 'This folder contains an unmanaged/older installation. Choose a new folder; do not overwrite its private data.' }
    }
    $selected=@($assets|ForEach-Object {$_.id});$retained=@($oldAssets|Where-Object {$_.id -notin $selected});$nextAssets=@($assets)+$retained
    $nextFiles=@{};$oldFiles=@{}
    foreach ($asset in $nextAssets) { foreach ($property in $asset.files.PSObject.Properties) { [void](Get-SafeChild $target $property.Name -ProtectUserData);$nextFiles[$property.Name]=$property.Value } }
    foreach ($asset in $oldAssets) { foreach ($property in $asset.files.PSObject.Properties) { [void](Get-SafeChild $target $property.Name -ProtectUserData);$oldFiles[$property.Name]=$property.Value } }
    $transaction=[Guid]::NewGuid().ToString('N');$staging=Join-Path $target ('.update-staging-'+$transaction)
    $backup=Join-Path $target ('backups/'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+$transaction)
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
        Write-Host "Installing $($Manifest.version); models: $($Models -join ', '). WaveGen checkpoints use CC BY-NC 4.0 (noncommercial)."
        $pendingAssets=@();$stagedExpected=@{}
        foreach ($asset in $assets) {
            $complete=$true
            foreach ($property in $asset.files.PSObject.Properties) {
                $path=Get-SafeChild $target $property.Name -ProtectUserData
                if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileDigest $path) -ne ([string]$property.Value).ToLowerInvariant()) { $complete=$false;break }
            }
            if ($complete) { Write-Host "Keeping verified installed component: $($asset.id)";continue }
            $pendingAssets+=$asset
            foreach ($property in $asset.files.PSObject.Properties) { $stagedExpected[$property.Name]=([string]$property.Value).ToLowerInvariant() }
        }
        $pendingAssets=@(Resolve-ModelPackages -Manifest $Manifest -PendingAssets $pendingAssets -CacheDirectory $CacheDirectory -Offline:$Offline)
        foreach ($asset in $pendingAssets) {
            $archive=Join-Path $CacheDirectory $asset.name
            if ($Offline) { if (!(Test-Path -LiteralPath $archive) -or (Get-FileDigest $archive) -ne $asset.sha256) { throw "Offline archive checksum failed: $($asset.name)" } }
            else { Get-VerifiedDownload -Uri $asset.url -Destination $archive -Sha256 $asset.sha256 }
            if ((Get-Item -LiteralPath $archive).Length -ne $asset.size) { throw "Archive size mismatch: $($asset.name)" }
            Expand-SafeZip -Archive $archive -Destination $staging -AllowExisting -ProtectUserData
        }
        $stagedFiles=@(Get-ChildItem -LiteralPath $staging -Recurse -File)
        if ($stagedFiles.Count -ne $stagedExpected.Count) { throw 'Archive contains unlisted or missing files.' }
        foreach ($relative in $stagedExpected.Keys) {
            $file=Get-SafeChild $staging $relative -ProtectUserData
            if (!(Test-Path -LiteralPath $file) -or (Get-FileDigest $file) -ne $stagedExpected[$relative]) { throw "Extracted file checksum failed: $relative" }
        }
        $changes=@($stagedExpected.Keys|Where-Object { $p=Get-SafeChild $target $_ -ProtectUserData; !(Test-Path -LiteralPath $p) -or (Get-FileDigest $p) -ne $stagedExpected[$_] })
        $removals=@($oldFiles.Keys|Where-Object { !$nextFiles.ContainsKey($_) -and (Test-Path -LiteralPath (Get-SafeChild $target $_ -ProtectUserData)) })
        Assert-AppClosed $target
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        $affected=@($changes)+@($removals)+@('.studio-install.json');$existed=@{}
        foreach ($relative in $affected) {
            $path=Get-SafeChild $target $relative -ProtectUserData
            if (Test-Path -LiteralPath $path) {
                if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "A managed file path is a directory: $relative" }
                $existed[$relative]=$true;$copy=Get-SafeChild $backup $relative
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy) | Out-Null
                Copy-Item -LiteralPath $path -Destination $copy
            }
        }
        try {
            foreach ($relative in $changes) {
                $path=Get-SafeChild $target $relative -ProtectUserData
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
                Copy-Item -LiteralPath (Get-SafeChild $staging $relative) -Destination $path -Force
            }
            foreach ($relative in $removals) { Remove-Item -LiteralPath (Get-SafeChild $target $relative -ProtectUserData) -Force }
            $record=[ordered]@{schema_version=1;version=$Manifest.version;repository=$Manifest.repository;installed_utc=[DateTime]::UtcNow.ToString('o');assets=$nextAssets}
            if ($Manifest.PSObject.Properties['model_config']) { $record['model_config']=$Manifest.model_config }
            [IO.File]::WriteAllText($statePath,($record|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
        } catch {
            # Roll back only files in this transaction, never data or unrelated files.
            foreach ($relative in $affected) {
                $path=Get-SafeChild $target $relative -ProtectUserData
                if ($existed.ContainsKey($relative)) { Copy-Item -LiteralPath (Get-SafeChild $backup $relative) -Destination $path -Force }
                elseif (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
            }
            throw
        }
        Write-Host "Ready: $target"
        Write-Host "Backup of replaced files: $backup"
        Write-Host 'Your data/ and all unrelated files were preserved. Launch WaveGen Studio.exe when ready.'
    } finally {
        $resolved=[IO.Path]::GetFullPath($staging)
        if ($resolved.StartsWith($target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -eq ('.update-staging-'+$transaction)) {
            if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
        }
    }
}
