# Portable contract tests. These mocks do not exercise Certum or Windows trust.
$ErrorActionPreference = 'Stop'
$scriptUnderTest = Join-Path $PSScriptRoot 'sign-windows.ps1'
$tokens = $null
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($scriptUnderTest, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
$oldThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT
$oldProgramFiles = ${env:ProgramFiles(x86)}
$env:WINDOWS_CERTIFICATE_THUMBPRINT = 'AB' * 20
${env:ProgramFiles(x86)} = 'mock-sdk'
$global:signingTestcalls = @()
$global:signingTestfailCommand = ''
$global:signingTestsignature = $null

function Get-Item { param($LiteralPath, $ErrorAction) [pscustomobject]@{ FullName = $LiteralPath } }
function Get-ChildItem {
    param($Path, [switch]$File)
    [pscustomobject]@{ FullName = 'Invoke-MockSignTool'; Directory = @{ Parent = @{ Name = '10.0.26100.0' } } }
}
function Invoke-MockSignTool {
    $global:signingTestcalls += ,@($args)
    $global:LASTEXITCODE = if ($args[0] -eq $global:signingTestfailCommand) { 1 } else { 0 }
}
function Get-AuthenticodeSignature { param($LiteralPath) $global:signingTestsignature }
function Reset-Fixture {
    $global:signingTestcalls = @()
    $global:signingTestfailCommand = ''
    $global:signingTestsignature = [pscustomobject]@{
        Status = 'Valid'
        SignerCertificate = [pscustomobject]@{ Thumbprint = 'AB' * 20 }
        TimeStamperCertificate = [pscustomobject]@{ Subject = 'Mock TSA' }
    }
}
function Assert-Fails($Action, $Expected) {
    $message = $null
    try { & $Action } catch { $message = $_.Exception.Message }
    if (-not $message -or $message -notlike "*$Expected*") {
        throw "Expected failure containing '$Expected'; got '$message'."
    }
}
try {
    Reset-Fixture
    & $scriptUnderTest -Path 'installer with spaces.exe'
    if ($global:signingTestcalls.Count -ne 2 -or $global:signingTestcalls[0][0] -ne 'sign' -or $global:signingTestcalls[1][0] -ne 'verify') {
        throw 'Signing must be followed by verification.'
    }
    if ($global:signingTestcalls[0][-1] -ne 'installer with spaces.exe' -or $global:signingTestcalls[0] -notcontains '/tr') {
        throw 'Signing must preserve file arguments and request an RFC3161 timestamp.'
    }
    Reset-Fixture
    & $scriptUnderTest -Path 'nsis.exe' -VerifyOnly
    if ($global:signingTestcalls.Count -ne 1 -or $global:signingTestcalls[0][0] -ne 'verify') {
        throw 'Verification must not mutate the already updater-signed NSIS installer.'
    }
    Reset-Fixture
    $global:signingTestfailCommand = 'sign'
    Assert-Fails { & $scriptUnderTest -Path 'installer.exe' } 'signing failed'
    if ($global:signingTestcalls.Count -ne 1) { throw 'Failed signing must stop immediately.' }
    Reset-Fixture
    $global:signingTestfailCommand = 'verify'
    Assert-Fails { & $scriptUnderTest -Path 'installer.exe' -VerifyOnly } 'verification failed'
    Reset-Fixture
    $global:signingTestsignature.Status = 'HashMismatch'
    Assert-Fails { & $scriptUnderTest -Path 'installer.exe' -VerifyOnly } 'Invalid Authenticode'
    Reset-Fixture
    $global:signingTestsignature.SignerCertificate.Thumbprint = 'CD' * 20
    Assert-Fails { & $scriptUnderTest -Path 'installer.exe' -VerifyOnly } 'Unexpected signing certificate'
    Reset-Fixture
    $global:signingTestsignature.TimeStamperCertificate = $null
    Assert-Fails { & $scriptUnderTest -Path 'installer.exe' -VerifyOnly } 'Missing Authenticode timestamp'
    $env:WINDOWS_CERTIFICATE_THUMBPRINT = 'bad'
    Assert-Fails { & $scriptUnderTest -Path 'installer.exe' } 'fingerprint'
    Write-Host 'Passed 8 Windows signing contract cases (mocked).'
} finally {
    $env:WINDOWS_CERTIFICATE_THUMBPRINT = $oldThumbprint
    ${env:ProgramFiles(x86)} = $oldProgramFiles
    Remove-Variable signingTestcalls, signingTestfailCommand, signingTestsignature -Scope Global -ErrorAction SilentlyContinue
}
