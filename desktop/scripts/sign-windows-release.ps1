param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$Path
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:SOURCENERVE_WINDOWS_CERTIFICATE_BASE64)) {
  throw "missing protected Windows signing value: SOURCENERVE_WINDOWS_CERTIFICATE_BASE64"
}
if ([string]::IsNullOrWhiteSpace($env:SOURCENERVE_WINDOWS_CERT_PASSWORD)) {
  throw "missing protected Windows signing value: SOURCENERVE_WINDOWS_CERT_PASSWORD"
}

function Resolve-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path $kitsRoot)) { throw "signtool.exe was not found" }
  $candidate = Get-ChildItem $kitsRoot -Filter signtool.exe -Recurse -File |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $candidate) { throw "signtool.exe was not found in the Windows SDK" }
  return $candidate.FullName
}

$targets = @()
foreach ($pattern in $Path) {
  $matches = @(Resolve-Path $pattern -ErrorAction SilentlyContinue)
  if ($matches.Count -eq 0) { throw "Windows signing target does not exist: $pattern" }
  foreach ($match in $matches) {
    if ((Get-Item $match.Path).PSIsContainer) { throw "Windows signing target is a directory: $($match.Path)" }
    $targets += $match.Path
  }
}
$targets = @($targets | Select-Object -Unique)

$signtool = Resolve-SignTool
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$pfx = Join-Path $tempRoot ("sourcenerve-signing-{0}.pfx" -f [guid]::NewGuid().ToString("N"))

try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:SOURCENERVE_WINDOWS_CERTIFICATE_BASE64))
  foreach ($target in $targets) {
    & $signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $pfx /p $env:SOURCENERVE_WINDOWS_CERT_PASSWORD /v $target
    if ($LASTEXITCODE -ne 0) { throw "Authenticode signing failed for $target" }
    & $signtool verify /pa /all /v $target
    if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed immediately after signing: $target" }
  }
}
finally {
  if (Test-Path $pfx) { Remove-Item -Force $pfx }
}

Write-Host "signed and verified $($targets.Count) Windows release artifact(s)"
