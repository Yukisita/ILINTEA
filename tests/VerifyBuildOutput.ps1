param(
    [ValidateSet('Debug', 'Release')]
    [string[]]$Configuration = @('Debug', 'Release'),
    [string]$ArtifactsPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$applicationRoot = Join-Path $repositoryRoot 'src/ILINTEA'
$sourceRoot = Join-Path $applicationRoot 'wwwroot'
$sourceFiles = @(Get-ChildItem -LiteralPath $sourceRoot -File -Recurse)
$executable = if ([Environment]::OSVersion.Platform -eq 'Win32NT') { 'ILINTEA.exe' } else { 'ILINTEA' }
$noticeFiles = @('LICENSE', 'THIRD-PARTY-NOTICES.txt',
    'licenses/SkiaSharp/LICENSE.txt', 'licenses/SkiaSharp/THIRD-PARTY-NOTICES.txt',
    'licenses/SkiaSharp/ADDITIONAL-NOTICES.txt')

foreach ($configurationName in $Configuration) {
    $outputRoot = if ($ArtifactsPath) {
        Join-Path $ArtifactsPath "bin/ILINTEA/$($configurationName.ToLowerInvariant())"
    } else {
        Join-Path $applicationRoot "bin/$configurationName"
    }
    foreach ($requiredFile in (@($executable, 'ILINTEA.dll', 'ILINTEA.deps.json', 'ILINTEA.runtimeconfig.json', 'ILINTEA.ini') + $noticeFiles)) {
        if (-not (Test-Path -LiteralPath (Join-Path $outputRoot $requiredFile) -PathType Leaf)) {
            throw "$configurationName output is missing $requiredFile. Build this configuration first."
        }
    }

    foreach ($notice in $noticeFiles) {
        if ((Get-FileHash -LiteralPath (Join-Path $repositoryRoot $notice)).Hash -ne
            (Get-FileHash -LiteralPath (Join-Path $outputRoot $notice)).Hash) {
            throw "$configurationName output has an outdated $notice."
        }
    }

    foreach ($sourceFile in $sourceFiles) {
        $relativePath = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart('\', '/')
        $outputFile = Join-Path (Join-Path $outputRoot 'wwwroot') $relativePath
        if (-not (Test-Path -LiteralPath $outputFile -PathType Leaf)) {
            throw "$configurationName output is missing wwwroot/$relativePath."
        }
        if ((Get-FileHash -LiteralPath $sourceFile.FullName).Hash -ne (Get-FileHash -LiteralPath $outputFile).Hash) {
            throw "$configurationName output has an outdated wwwroot/$relativePath."
        }
    }

    if (Test-Path -LiteralPath (Join-Path $outputRoot 'ILINTEA.staticwebassets.runtime.json')) {
        throw "$configurationName output still contains a source-tree web asset manifest."
    }
    Write-Output "$configurationName output verified: application, configuration and $($sourceFiles.Count) web assets."
}
