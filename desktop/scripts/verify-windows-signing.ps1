param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$Path
)

$ErrorActionPreference = "Stop"

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
  $targets += @($matches | ForEach-Object { $_.Path })
}
$targets = @($targets | Select-Object -Unique)
$signtool = Resolve-SignTool

foreach ($target in $targets) {
  $signature = Get-AuthenticodeSignature $target
  if ($signature.Status -ne "Valid") {
    throw "Windows signing gate failed for $target: $($signature.Status)"
  }
  if (-not $signature.SignerCertificate) {
    throw "Windows signing gate found no signer certificate for $target"
  }
  if ($signature.SignerCertificate.NotAfter -le (Get-Date)) {
    throw "Windows signing certificate is expired for $target"
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Windows release signature is missing an RFC3161 timestamp for $target"
  }
  & $signtool verify /pa /all /v $target
  if ($LASTEXITCODE -ne 0) { throw "signtool verification failed for $target" }
}

Write-Host "verified Authenticode signer, timestamp, and Windows trust policy for $($targets.Count) artifact(s)"
