[CmdletBinding()]
param(
    [string]$BinDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'OpenBitFun\bin'),
    [switch]$SkipPathUpdate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-RepoRoot {
    $candidate = (Resolve-Path $PSScriptRoot).Path
    while ($candidate) {
        $manifest = Join-Path $candidate 'Cargo.toml'
        $cliDirectory = Join-Path $candidate 'src\apps\cli'
        if ((Test-Path -LiteralPath $manifest -PathType Leaf) -and
            (Test-Path -LiteralPath $cliDirectory -PathType Container) -and
            (Select-String -LiteralPath $manifest -Pattern '^\[workspace\]' -Quiet)) {
            return $candidate
        }

        $parent = Split-Path -Parent $candidate
        if (-not $parent -or $parent -eq $candidate) {
            break
        }
        $candidate = $parent
    }

    throw "Could not locate the OpenBitFun repository root from $PSScriptRoot"
}

function Resolve-TargetRoot([string]$RepoRoot) {
    if (-not $env:CARGO_TARGET_DIR) {
        return Join-Path $RepoRoot 'target'
    }
    if ([IO.Path]::IsPathRooted($env:CARGO_TARGET_DIR)) {
        return [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
    }
    return [IO.Path]::GetFullPath((Join-Path $RepoRoot $env:CARGO_TARGET_DIR))
}

function Resolve-ReleaseDir([string]$RepoRoot) {
    $targetRoot = Resolve-TargetRoot $RepoRoot
    if ($env:CARGO_BUILD_TARGET) {
        return Join-Path $targetRoot "$($env:CARGO_BUILD_TARGET)\release"
    }
    return Join-Path $targetRoot 'release'
}

function Add-BinDirToUserPath([string]$Directory) {
    $normalizedDirectory = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    $alreadyPresent = $entries | Where-Object {
        try {
            [IO.Path]::GetFullPath($_).TrimEnd('\') -ieq $normalizedDirectory
        }
        catch {
            $_.TrimEnd('\') -ieq $normalizedDirectory
        }
    }

    if (-not $alreadyPresent) {
        $updated = (@($entries) + $normalizedDirectory) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        Write-Host "Added $normalizedDirectory to the user PATH."
    }
    else {
        Write-Host "$normalizedDirectory is already on the user PATH."
    }

}

function Assert-CommandSucceeded([string]$Description) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Assert-Entrypoint([string]$Executable) {
    & $Executable --version | Out-Null
    Assert-CommandSucceeded 'openbitfun --version'
    & $Executable --help | Out-Null
    Assert-CommandSucceeded 'openbitfun --help'
}

function Assert-PluginHostResources([string]$Directory) {
    foreach ($entry in @('extension-host.js')) {
        $path = Join-Path $Directory $entry
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Plugin Host resource is missing: $path"
        }
    }
}

function Install-OpenBitFunCli(
    [string]$PrimarySource,
    [string]$PluginHostSource,
    [string]$Destination
) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $installLock = [IO.File]::Open((Join-Path $Destination '.openbitfun-cli-install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stageDir = Join-Path $Destination ".openbitfun-install-$([guid]::NewGuid().ToString('N'))"
    $stagedPrimary = Join-Path $stageDir 'openbitfun.exe'
    $stagedPluginHost = Join-Path $stageDir 'ext-host'
    $primaryTarget = Join-Path $Destination 'openbitfun.exe'
    $pluginHostTarget = Join-Path $Destination 'resources\ext-host'
    $primaryBackup = Join-Path $stageDir 'previous-openbitfun.exe'
    $pluginHostBackup = Join-Path $stageDir 'previous-ext-host'
    $completed = $false
    $primaryBackedUp = $false
    $pluginHostBackedUp = $false
    $primaryCommitted = $false
    $pluginHostCommitted = $false

    try {
        New-Item -ItemType Directory -Path $stageDir | Out-Null
        Copy-Item -LiteralPath $PrimarySource -Destination $stagedPrimary
        New-Item -ItemType Directory -Path $stagedPluginHost | Out-Null
        Copy-Item -LiteralPath (Join-Path $PluginHostSource 'extension-host.js') -Destination $stagedPluginHost
        Assert-Entrypoint $stagedPrimary
        Assert-PluginHostResources $stagedPluginHost

        if (Test-Path -LiteralPath $primaryTarget -PathType Leaf) {
            Move-Item -LiteralPath $primaryTarget -Destination $primaryBackup
            $primaryBackedUp = $true
        }
        if (Test-Path -LiteralPath $pluginHostTarget -PathType Container) {
            Move-Item -LiteralPath $pluginHostTarget -Destination $pluginHostBackup
            $pluginHostBackedUp = $true
        }

        Move-Item -LiteralPath $stagedPrimary -Destination $primaryTarget
        $primaryCommitted = $true
        New-Item -ItemType Directory -Path (Split-Path -Parent $pluginHostTarget) -Force | Out-Null
        Move-Item -LiteralPath $stagedPluginHost -Destination $pluginHostTarget
        $pluginHostCommitted = $true
        Assert-Entrypoint $primaryTarget
        Assert-PluginHostResources $pluginHostTarget
        $completed = $true
    }
    catch {
        $installError = $_
        if ($pluginHostCommitted) {
            Remove-Item -LiteralPath $pluginHostTarget -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($primaryCommitted) {
            Remove-Item -LiteralPath $primaryTarget -Force -ErrorAction SilentlyContinue
        }
        if ($primaryBackedUp) {
            Move-Item -LiteralPath $primaryBackup -Destination $primaryTarget -Force
        }
        if ($pluginHostBackedUp) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $pluginHostTarget) -Force | Out-Null
            Move-Item -LiteralPath $pluginHostBackup -Destination $pluginHostTarget -Force
        }
        $completed = $true
        throw "CLI installation failed; the previous OpenBitFun CLI was restored. $installError"
    }
    finally {
        try {
            $resolvedStage = [IO.Path]::GetFullPath($stageDir)
            $resolvedRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
            if (-not $resolvedStage.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Invalid CLI staging path'
            }
            if ($completed) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue }
            else { Write-Warning "CLI recovery requires repair. Backups retained at $resolvedStage" }
        }
        finally {
            $installLock.Dispose()
        }
    }
}

$repoRoot = Resolve-RepoRoot
$releaseDir = Resolve-ReleaseDir $repoRoot
$primarySource = Join-Path $releaseDir 'openbitfun.exe'
$pluginHostSource = Join-Path $repoRoot 'src\apps\extension-host\dist'
$primaryInstalled = Join-Path $BinDir 'openbitfun.exe'

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'cargo was not found. Install Rust from https://rustup.rs and re-run.'
}
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
    throw 'rustc was not found. Install Rust from https://rustup.rs and re-run.'
}

Write-Host '=== OpenBitFun CLI Install ==='
Write-Host "Repo: $repoRoot"
Write-Host "Install dir: $BinDir"

Push-Location $repoRoot
try {
    Write-Host '[1/3] Building openbitfun...'
    & cargo build -p openbitfun-cli --release --bin openbitfun
    Assert-CommandSucceeded 'cargo build'
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $primarySource -PathType Leaf)) {
    throw "Built executable was not found at $primarySource"
}
Assert-PluginHostResources $pluginHostSource

Write-Host '[2/3] Installing executable...'
Install-OpenBitFunCli $primarySource $pluginHostSource $BinDir
Write-Host "Installed: $primaryInstalled"
Write-Host "Installed plugin Host resources: $(Join-Path $BinDir 'resources\ext-host')"

if (-not $SkipPathUpdate) {
    Add-BinDirToUserPath $BinDir
}
else {
    Write-Host 'Skipped the user PATH update (-SkipPathUpdate).'
}

Write-Host '[3/3] Verifying openbitfun...'
Assert-Entrypoint $primaryInstalled
Assert-PluginHostResources (Join-Path $BinDir 'resources\ext-host')

Write-Host '=== Install complete ==='
Write-Host 'Open a new terminal, then run: openbitfun'
Write-Host "Current PowerShell: `$env:Path = `"$([IO.Path]::GetFullPath($BinDir));`$env:Path`"; openbitfun"
Write-Host "Direct path: $primaryInstalled"
