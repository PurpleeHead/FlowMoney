$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$expectedBranch = "feature/personal-finance-rework"
$root = $PSScriptRoot
Push-Location $root
$backup = Join-Path $env:TEMP ("flowmoney-package-lock-" + [guid]::NewGuid().ToString("N") + ".json")

try {
  $nodeVersion = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Node.js is not available." }
  $major = [int](($nodeVersion -replace '^v', '').Split('.')[0])
  if ($major -lt 22) { throw "Node.js 22 or newer is required. Detected: $nodeVersion" }

  $currentBranch = (& git branch --show-current).Trim()
  if ($LASTEXITCODE -ne 0 -or $currentBranch -ne $expectedBranch) {
    throw "Switch to '$expectedBranch' before running this script. Current branch: '$currentBranch'."
  }

  $changes = & git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect Git status." }
  if ($changes) { throw "Working tree is not clean. Commit or stash your changes before dependency maintenance." }

  $lockPath = Join-Path $root "package-lock.json"
  if (-not (Test-Path $lockPath)) { throw "Root package-lock.json was not found." }
  Copy-Item $lockPath $backup -Force

  Write-Host "Installing the currently locked dependencies..."
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed. No dependency changes were retained." }

  Write-Host "Applying compatible security updates only (no --force)..."
  & npm audit fix
  $auditFixExit = $LASTEXITCODE
  if ($auditFixExit -gt 1) { throw "npm audit fix failed with exit code $auditFixExit." }

  Write-Host "Checking production and client builds..."
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed after dependency updates." }

  Write-Host "Running server and client tests..."
  & npm test
  if ($LASTEXITCODE -ne 0) { throw "Tests failed after dependency updates." }

  $auditFile = Join-Path $env:TEMP ("flowmoney-audit-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    & npm audit --json 2>&1 | Out-File -FilePath $auditFile -Encoding utf8
    $audit = Get-Content $auditFile -Raw | ConvertFrom-Json
    $v = $audit.metadata.vulnerabilities
    Write-Host ""
    Write-Host ("Remaining advisories: critical={0}, high={1}, moderate={2}, low={3}, total={4}" -f $v.critical, $v.high, $v.moderate, $v.low, $v.total)
  } finally {
    Remove-Item $auditFile -Force -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "Build and tests passed. Review the package-lock.json change before committing it."
  Write-Host "No files were committed and no deployment or database migration was performed."
}
catch {
  if (Test-Path $backup) {
    Copy-Item $backup (Join-Path $root "package-lock.json") -Force
    Write-Warning "Restored the original package-lock.json because the update or verification failed."
    & npm ci
    if ($LASTEXITCODE -ne 0) { Write-Warning "Could not restore node_modules automatically; run npm ci manually." }
  }
  throw
}
finally {
  Remove-Item $backup -Force -ErrorAction SilentlyContinue
  Pop-Location
}
