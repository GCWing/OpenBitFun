# Sign/verify before updater signatures and release checksums are generated.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$thumbprint = ($env:WINDOWS_CERTIFICATE_THUMBPRINT -replace '\s', '').ToUpperInvariant()
if ($thumbprint -notmatch '^[0-9A-F]{40}$') {
    throw 'WINDOWS_CERTIFICATE_THUMBPRINT must be a SHA-1 certificate fingerprint.'
}
$file = (Get-Item -LiteralPath $Path -ErrorAction Stop).FullName
$tools = @(Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -File |
    Sort-Object { [version]$_.Directory.Parent.Name } -Descending)
if ($tools.Count -eq 0) { throw 'Windows SDK x64 signtool.exe was not found.' }
$signtool = $tools[0].FullName

if (-not $VerifyOnly) {
    & $signtool sign /sha1 $thumbprint /fd SHA256 /tr http://time.certum.pl /td SHA256 /v $file
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed: $file (exit $LASTEXITCODE)" }
}

& $signtool verify /pa /all /tw /v $file
if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed: $file (exit $LASTEXITCODE)" }
$signature = Get-AuthenticodeSignature -LiteralPath $file
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw "Invalid Authenticode signature: $file ($($signature.Status))"
}
if ($signature.SignerCertificate.Thumbprint -ne $thumbprint) {
    throw "Unexpected signing certificate: $file"
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw "Missing Authenticode timestamp: $file"
}
Write-Host "Verified Authenticode signature and timestamp: $file"
