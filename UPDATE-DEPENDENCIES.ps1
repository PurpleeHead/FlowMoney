$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$expectedBranch = "feature/personal-finance-rework"
$registry = "https://registry.npmjs.org/"
$root = $PSScriptRoot
Push-Location $root
$backup = Join-Path $env:TEMP ("flowmoney-package-lock-" + [guid]::NewGuid().ToString("N") + ".json")

function Invoke-Npm {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  & npm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage Exit code: $LASTEXITCODE"
  }
}

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

  Write-Host "Installing locked dependencies from the official npm registry..."
  Invoke-Npm -Arguments @("ci", "--registry=$registry") -FailureMessage "npm ci failed."

  Write-Host "Generating Prisma Client before TypeScript compilation..."
  Invoke-Npm -Arguments @("run", "db:generate", "--", "--schema", "server/prisma/schema.prisma") -FailureMessage "Prisma Client generation failed."

  Write-Host "Applying compatible security updates only (no --force)..."
  & npm audit fix "--registry=$registry"
  $auditFixExit = $LASTEXITCODE
  if ($auditFixExit -gt 1) { throw "npm audit fix failed operationally with exit code $auditFixExit. The final audit below will distinguish remaining advisories from registry errors." }

  Write-Host "Regenerating Prisma Client after dependency updates..."
  Invoke-Npm -Arguments @("run", "db:generate", "--", "--schema", "server/prisma/schema.prisma") -FailureMessage "Prisma Client generation failed after updates."

  Write-Host "Checking production and client builds..."
  Invoke-Npm -Arguments @("run", "build") -FailureMessage "Build failed after dependency updates."

  Write-Host "Running server and client tests..."
  Invoke-Npm -Arguments @("test") -FailureMessage "Tests failed after dependency updates."

  $auditFile = Join-Path $env:TEMP ("flowmoney-audit-" + [guid]::NewGuid().ToString("N") + ".json")
  try {
    & npm audit --json "--registry=$registry" | Out-File -FilePath $auditFile -Encoding utf8
    $auditExit = $LASTEXITCODE
    try {
      $audit = Get-Content $auditFile -Raw | ConvertFrom-Json
    } catch {
      throw "npm audit did not return valid JSON. Check registry/network access and retry."
    }
    if ($auditExit -gt 1) { throw "npm audit failed operationally with exit code $auditExit." }

    $v = $audit.metadata.vulnerabilities
    Write-Host ""
    Write-Host ("Remaining advisories: critical={0}, high={1}, moderate={2}, low={3}, total={4}" -f $v.critical, $v.high, $v.moderate, $v.low, $v.total)
  } finally {
    Remove-Item $auditFile -Force -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "Build and tests passed. Review package-lock.json and remaining advisories before committing."
  Write-Host "No files were committed and no deployment or database migration was performed."
}
catch {
  if (Test-Path $backup) {
    Copy-Item $backup (Join-Path $root "package-lock.json") -Force
    Write-Warning "Restored the original package-lock.json because the update or verification failed."
    & npm ci "--registry=$registry"
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "Could not restore node_modules automatically; run npm ci --registry=$registry manually."
    } else {
      & npm run db:generate
      if ($LASTEXITCODE -ne 0) { Write-Warning "Prisma Client regeneration failed after rollback; run npm run db:generate manually." }
    }
  }
  throw
}
finally {
  Remove-Item $backup -Force -ErrorAction SilentlyContinue
  Pop-Location
}
