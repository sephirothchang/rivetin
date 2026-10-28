param([string]$Go)
$ErrorActionPreference = 'Stop'
$goOptions = @()
if ($Go) { $goOptions = @('--go', (Get-Command $Go -CommandType Application -ErrorAction Stop).Source) }
$cliRoot = Split-Path $PSScriptRoot -Parent
Push-Location $cliRoot
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
try {
    & node scripts/toolchain.mjs @goOptions --run-go mod download
    if ($LASTEXITCODE -ne 0) { throw 'Module download failed.' }
    & node scripts/toolchain.mjs @goOptions --run-go mod verify
    if ($LASTEXITCODE -ne 0) { throw 'Module verification failed.' }
    & node scripts/prepare.mjs @goOptions
    if ($LASTEXITCODE -ne 0) { throw 'Payload preparation failed.' }
    New-Item -ItemType Directory -Force -Path 'release' | Out-Null
    foreach ($targetOS in @('windows', 'linux', 'darwin')) {
        foreach ($targetArch in @('amd64', 'arm64')) {
            $env:GOOS = $targetOS
            $env:GOARCH = $targetArch
            $suffix = if ($targetOS -eq 'windows') { '.exe' } else { '' }
            $artifact = "release/rivetin-$targetOS-$targetArch$suffix"
            & node scripts/toolchain.mjs @goOptions --run-go build -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o $artifact .
            if ($LASTEXITCODE -ne 0) { throw "Build failed: $targetOS/$targetArch" }
        }
    }
    Copy-Item -LiteralPath '../LICENSE' -Destination 'release/LICENSE'
    Copy-Item -LiteralPath 'payload/NOTICES.txt' -Destination 'release/THIRD_PARTY_NOTICES.txt'
    Get-ChildItem release/rivetin-* | Sort-Object Name | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  $(Split-Path $_.Path -Leaf)" } | Set-Content -Encoding utf8NoBOM release/SHA256SUMS
} finally {
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
    Pop-Location
}
