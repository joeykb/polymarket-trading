<#
  TempEdge Blue-Green Promotion Script
  Promotes the green stack to production by:
    1. Validating green pod health
    2. Re-tagging green Docker images as :latest
    3. Updating production (blue) deployments with green images
    4. Scaling up production stack
    5. Tearing down green-specific resources
#>

param(
    [switch]$DryRun,
    [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'
$namespace = "tempedge"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  TempEdge Green -> Production Promotion" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ── Step 1: Validate Green Health ──────────────────────────────────────
if (-not $SkipValidation) {
    Write-Host "[1/5] Validating green pod health..." -ForegroundColor Yellow

    $greenDeps = @(
        "data-svc-green",
        "weather-svc-green",
        "market-svc-green",
        "liquidity-svc-green",
        "trading-svc-green",
        "monitor-green",
        "dashboard-svc-green"
    )

    $allHealthy = $true
    foreach ($dep in $greenDeps) {
        $ready = kubectl get deployment $dep -n $namespace -o jsonpath='{.status.readyReplicas}' 2>$null
        if ($ready -ge 1) {
            Write-Host "  [OK] $dep ($ready/$ready ready)" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] $dep is NOT ready" -ForegroundColor Red
            $allHealthy = $false
        }
    }

    if (-not $allHealthy) {
        Write-Host "`n[ABORT] Not all green deployments are healthy. Fix issues before promoting." -ForegroundColor Red
        exit 1
    }
    Write-Host "  All green pods healthy.`n" -ForegroundColor Green
} else {
    Write-Host "[1/5] Skipping validation (--SkipValidation)`n" -ForegroundColor DarkGray
}

# ── Step 2: Re-tag Docker Images ──────────────────────────────────────
Write-Host "[2/5] Re-tagging green Docker images as :latest..." -ForegroundColor Yellow

$images = @(
    "tempedge-data-svc",
    "tempedge-weather-svc",
    "tempedge-market-svc",
    "tempedge-liquidity-svc",
    "tempedge-trading-svc",
    "tempedge-monitor",
    "tempedge-dashboard-svc"
)

foreach ($img in $images) {
    $cmd = "docker tag ${img}:green ${img}:latest"
    if ($DryRun) {
        Write-Host "  [DRY-RUN] $cmd" -ForegroundColor DarkGray
    } else {
        Write-Host "  Tagging ${img}:green -> ${img}:latest"
        Invoke-Expression $cmd
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [FAIL] Could not tag $img" -ForegroundColor Red
            exit 1
        }
    }
}
Write-Host "  All images re-tagged.`n" -ForegroundColor Green

# ── Step 3: Rollout Production Deployments ────────────────────────────
Write-Host "[3/5] Rolling out production (blue) deployments with new images..." -ForegroundColor Yellow

$prodDeps = @(
    "data-svc",
    "weather-svc",
    "market-svc",
    "liquidity-svc",
    "trading-svc",
    "monitor",
    "dashboard-svc"
)

foreach ($dep in $prodDeps) {
    # Scale to 1 replica
    $scaleCmd = "kubectl scale deployment/$dep -n $namespace --replicas=1"
    # Force rollout to pick up the new :latest image
    $restartCmd = "kubectl rollout restart deployment/$dep -n $namespace"

    if ($DryRun) {
        Write-Host "  [DRY-RUN] $scaleCmd" -ForegroundColor DarkGray
        Write-Host "  [DRY-RUN] $restartCmd" -ForegroundColor DarkGray
    } else {
        Write-Host "  Scaling up $dep..."
        Invoke-Expression $scaleCmd
        Write-Host "  Restarting $dep to pick up new image..."
        Invoke-Expression $restartCmd
    }
}
Write-Host "  Production deployments updated.`n" -ForegroundColor Green

# ── Step 4: Wait for Production Readiness ─────────────────────────────
if (-not $DryRun) {
    Write-Host "[4/5] Waiting for production pods to become ready..." -ForegroundColor Yellow
    
    foreach ($dep in $prodDeps) {
        Write-Host "  Waiting for $dep..." -NoNewline
        $timeout = 120
        $elapsed = 0
        while ($elapsed -lt $timeout) {
            $ready = kubectl get deployment $dep -n $namespace -o jsonpath='{.status.readyReplicas}' 2>$null
            if ($ready -ge 1) {
                Write-Host " READY" -ForegroundColor Green
                break
            }
            Start-Sleep -Seconds 5
            $elapsed += 5
            Write-Host "." -NoNewline
        }
        if ($elapsed -ge $timeout) {
            Write-Host " TIMEOUT" -ForegroundColor Red
            Write-Host "`n  [WARNING] $dep did not become ready within ${timeout}s." -ForegroundColor Red
            Write-Host "  Production may be partially deployed. Check logs with:" -ForegroundColor Red
            Write-Host "    kubectl logs deployment/$dep -n $namespace" -ForegroundColor Yellow
            
            $continue = Read-Host "  Continue anyway? (y/N)"
            if ($continue -ne 'y') {
                Write-Host "  [ABORT] Promotion halted. Green stack is still running." -ForegroundColor Red
                exit 1
            }
        }
    }
    Write-Host "  All production pods ready.`n" -ForegroundColor Green
} else {
    Write-Host "[4/5] [DRY-RUN] Would wait for production pods`n" -ForegroundColor DarkGray
}

# ── Step 5: Tear Down Green Stack ─────────────────────────────────────
Write-Host "[5/5] Scaling down green deployments..." -ForegroundColor Yellow

$greenDeps = @(
    "data-svc-green",
    "weather-svc-green",
    "market-svc-green",
    "liquidity-svc-green",
    "trading-svc-green",
    "monitor-green",
    "dashboard-svc-green"
)

foreach ($dep in $greenDeps) {
    $cmd = "kubectl scale deployment/$dep -n $namespace --replicas=0"
    if ($DryRun) {
        Write-Host "  [DRY-RUN] $cmd" -ForegroundColor DarkGray
    } else {
        Write-Host "  Scaling down $dep..."
        Invoke-Expression $cmd
    }
}
Write-Host "  Green stack scaled to 0.`n" -ForegroundColor Green

# ── Summary ───────────────────────────────────────────────────────────
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Promotion Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Production dashboard: http://localhost:30301" -ForegroundColor White
Write-Host "  Green dashboard (offline): http://localhost:30302" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Verify with:" -ForegroundColor Yellow
Write-Host "    kubectl get pods -n $namespace" -ForegroundColor White
Write-Host ""

if ($DryRun) {
    Write-Host "  ** This was a DRY RUN -- no changes were made **" -ForegroundColor Yellow
}
