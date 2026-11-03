$raw = [Console]::In.ReadToEnd()
$hookInput = $raw | ConvertFrom-Json

if (
    $hookInput.tool_name -ne 'ExecCommand' -or
    $null -eq $hookInput.tool_input -or
    $null -eq $hookInput.tool_input.cmd
) {
    exit 0
}

$rtk = $env:RTK_BIN
if (-not $rtk) {
    $rtkCommand = Get-Command rtk.exe -ErrorAction SilentlyContinue
    if (-not $rtkCommand) {
        $rtkCommand = Get-Command rtk -ErrorAction SilentlyContinue
    }
    if ($rtkCommand) {
        $rtk = $rtkCommand.Source
    }
}
if (-not $rtk) {
    [Console]::Error.WriteLine('RTK hook: rtk was not found; leaving the command unchanged.')
    exit 0
}

$stderrPath = [IO.Path]::GetTempFileName()

try {
    $rewrittenLines = @(
        & $rtk rewrite -- ([string]$hookInput.tool_input.cmd) 2> $stderrPath
    )
    $rtkExit = $LASTEXITCODE
    $rtkError = (
        Get-Content -LiteralPath $stderrPath -Raw `
            -ErrorAction SilentlyContinue
    ).Trim()
}
finally {
    Remove-Item -LiteralPath $stderrPath -Force `
        -ErrorAction SilentlyContinue
}

switch ($rtkExit) {
    0 { $decision = 'allow' }
    1 { exit 0 }
    2 {
        if ($rtkError) {
            [Console]::Error.WriteLine($rtkError)
        } else {
            [Console]::Error.WriteLine('RTK denied this command.')
        }
        exit 2
    }
    3 { $decision = $null }
    default { exit 0 }
}

$rewritten = ($rewrittenLines -join "`n").Trim()
if (-not $rewritten) {
    exit 0
}

$updated = [ordered]@{}
foreach ($property in $hookInput.tool_input.PSObject.Properties) {
    $updated[$property.Name] = $property.Value
}
$updated['cmd'] = $rewritten

$specific = [ordered]@{
    hookEventName = 'PreToolUse'
    updatedInput = [pscustomobject]$updated
}

if ($decision) {
    $specific.permissionDecision = $decision
    $specific.permissionDecisionReason = 'RTK auto-rewrite'
}

[ordered]@{
    hookSpecificOutput = [pscustomobject]$specific
} | ConvertTo-Json -Compress -Depth 20

exit 0
