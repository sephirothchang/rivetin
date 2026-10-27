param([Parameter(Mandatory=$true)][string]$Go)
$ErrorActionPreference = 'Stop'
$Go = (Get-Command $Go -CommandType Application -ErrorAction Stop).Source
$cliRoot = Split-Path $PSScriptRoot -Parent
Push-Location $cliRoot
$previousOS = $env:GOOS
$previousArch = $env:GOARCH
$previousCGO = $env:CGO_ENABLED
$previousGoFlags = $env:GOFLAGS
$previousExperiment = $env:GOEXPERIMENT
$previousToolchain = $env:GOTOOLCHAIN
$previousGoPath = $env:GOPATH
$previousGoCache = $env:GOCACHE
try {
    $env:CGO_ENABLED = '0'
    $env:GOFLAGS = ''
    $env:GOEXPERIMENT = ''
    $env:GOTOOLCHAIN = 'local'
    if (-not $env:GOPATH) { $env:GOPATH = Join-Path $cliRoot '.local/go-cache' }
    if (-not $env:GOCACHE) { $env:GOCACHE = Join-Path $cliRoot '.local/go-build' }
    & $Go mod download
    if ($LASTEXITCODE -ne 0) { throw 'Module download failed.' }
    & $Go mod verify
    if ($LASTEXITCODE -ne 0) { throw 'Module verification failed.' }
    & node scripts/prepare.mjs --go $Go
    if ($LASTEXITCODE -ne 0) { throw 'Payload preparation failed.' }
    New-Item -ItemType Directory -Force -Path 'release' | Out-Null
    foreach ($targetOS in @('windows', 'linux', 'darwin')) {
        foreach ($targetArch in @('amd64', 'arm64')) {
            $env:GOOS = $targetOS
            $env:GOARCH = $targetArch
            $suffix = if ($targetOS -eq 'windows') { '.exe' } else { '' }
            $artifact = "release/pluginkit-$targetOS-$targetArch$suffix"
            & $Go build -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o $artifact .
            if ($LASTEXITCODE -ne 0) { throw "Build failed: $targetOS/$targetArch" }
        }
    }
    Copy-Item -LiteralPath '../LICENSE' -Destination 'release/LICENSE'
    Copy-Item -LiteralPath 'payload/NOTICES.txt' -Destination 'release/THIRD_PARTY_NOTICES.txt'
    Get-ChildItem release/pluginkit-* | Sort-Object Name | Get-FileHash -Algorithm SHA256 | ForEach-Object { "$($_.Hash.ToLower())  $(Split-Path $_.Path -Leaf)" } | Set-Content -Encoding utf8NoBOM release/SHA256SUMS
} finally {
    $env:GOOS = $previousOS
    $env:GOARCH = $previousArch
    $env:CGO_ENABLED = $previousCGO
    $env:GOFLAGS = $previousGoFlags
    $env:GOEXPERIMENT = $previousExperiment
    $env:GOTOOLCHAIN = $previousToolchain
    $env:GOPATH = $previousGoPath
    $env:GOCACHE = $previousGoCache
    Pop-Location
}
