<#
.SYNOPSIS
  TempEdge Monorepo CI/CD Pipeline
  Unified build, test, deploy, and blue-green lifecycle management.

.DESCRIPTION
  Single entry point for all deployment operations:
    pipeline.ps1 deploy              Build + deploy to production (blue stack)
    pipeline.ps1 deploy -Only X,Y   Build + deploy specific services
    pipeline.ps1 green               Build + deploy isolated green stack for testing
    pipeline.ps1 promote             Promote green -> production (safe image swap)
    pipeline.ps1 rollback            Rollback production to previous images
    pipeline.ps1 teardown            Remove green stack
    pipeline.ps1 teardown -Full      Remove everything (namespace, PVC)
    pipeline.ps1 status              Show cluster health

  Flags (combinable with any command):
    -NoBuild          Skip Docker image builds
    -SkipTests        Skip vitest test suite
    -SkipLint         Skip ESLint
    -Force            Skip confirmation prompts
    -DryRun           Show what would happen without executing

.EXAMPLE
  .\pipeline.ps1 deploy
  .\pipeline.ps1 green
  .\pipeline.ps1 promote -DryRun
  .\pipeline.ps1 deploy -Only monitor,trading-svc -SkipTests
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet("deploy", "green", "promote", "rollback", "teardown", "status")]
    [string]$Command = "deploy",

    [string]$Only = "",
    [switch]$NoBuild,
    [switch]$SkipTests,
    [switch]$SkipLint,
    [switch]$Force,
    [switch]$Full,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$namespace = "tempedge"
$repoRoot = $PSScriptRoot

# ============================================================================
# SERVICE REGISTRY (single source of truth)
# ============================================================================

$ServiceRegistry = @(
    @{ Name = "data-svc";      Image = "tempedge-data-svc";      Port = 3005; Dir = "services/data-svc";      Layer = 0 }
    @{ Name = "weather-svc";   Image = "tempedge-weather-svc";   Port = 3002; Dir = "services/weather-svc";   Layer = 0 }
    @{ Name = "market-svc";    Image = "tempedge-market-svc";    Port = 3003; Dir = "services/market-svc";    Layer = 0 }
    @{ Name = "trading-svc";   Image = "tempedge-trading-svc";   Port = 3004; Dir = "services/trading-svc";   Layer = 1 }
    @{ Name = "liquidity-svc"; Image = "tempedge-liquidity-svc"; Port = 3001; Dir = "services/liquidity-svc"; Layer = 1 }
    @{ Name = "dashboard-svc"; Image = "tempedge-dashboard-svc"; Port = 3000; Dir = "services/dashboard-svc"; Layer = 2 }
    @{ Name = "monitor";       Image = "tempedge-monitor";       Port = 0;    Dir = "services/monitor";       Layer = 3 }
)

$K8sBaseManifests = @(
    "k8s/namespace.yaml",
    "k8s/configmap.yaml",
    "k8s/vpn-secret.yaml",
    "k8s/trading-secret.yaml",
    "k8s/weather-api-keys-secret.yaml",
    "k8s/pvc.yaml"
)

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

function Write-Step {
    param([string]$Step, [string]$Message, [string]$Color = "Yellow")
    Write-Host "[$Step] $Message" -ForegroundColor $Color
}

function Write-Detail {
    param([string]$Message, [string]$Status = "OK", [string]$Color = "Green")
    $statusColors = @{ OK = "Green"; FAIL = "Red"; SKIP = "DarkGray"; WARN = "Yellow"; DRY = "DarkCyan"; WAIT = "White" }
    $c = if ($statusColors.ContainsKey($Status)) { $statusColors[$Status] } else { $Color }
    Write-Host "  [$Status] $Message" -ForegroundColor $c
}

function Invoke-Kubectl {
    param([string]$CmdArgs, [switch]$Silent)
    if ($DryRun) {
        Write-Detail "kubectl $CmdArgs" -Status "DRY"
        return $true
    }
    if ($Silent) {
        Invoke-Expression "kubectl $CmdArgs 2>&1" | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    Invoke-Expression "kubectl $CmdArgs"
    return ($LASTEXITCODE -eq 0)
}

function Get-FilteredServices {
    if ($Only -ne "") {
        $onlyList = $Only -split ","
        $filtered = $ServiceRegistry | Where-Object { $onlyList -contains $_.Name }
        if ($filtered.Count -eq 0) {
            Write-Host "[FAIL] No matching services: $Only" -ForegroundColor Red
            Write-Host "  Available: $(($ServiceRegistry | ForEach-Object { $_.Name }) -join ', ')" -ForegroundColor DarkGray
            exit 1
        }
        return $filtered
    }
    return $ServiceRegistry
}

function Get-LayeredServices {
    param($Services)
    $layers = @{}
    foreach ($svc in $Services) {
        $l = $svc.Layer
        if (-not $layers.ContainsKey($l)) { $layers[$l] = @() }
        $layers[$l] += $svc
    }
    return $layers.GetEnumerator() | Sort-Object Key
}

function Wait-ForDeployment {
    param([string]$Name, [int]$TimeoutSec = 120)
    if ($DryRun) { Write-Detail "$Name" -Status "DRY"; return $true }

    Write-Host "  [WAIT] $Name" -ForegroundColor White -NoNewline
    $elapsed = 0
    while ($elapsed -lt $TimeoutSec) {
        $ready = kubectl get deployment $Name -n $namespace -o jsonpath='{.status.readyReplicas}' 2>$null
        if ($ready -ge 1) {
            Write-Host " READY" -ForegroundColor Green
            return $true
        }
        Start-Sleep -Seconds 5
        $elapsed += 5
        Write-Host "." -NoNewline
    }
    Write-Host " TIMEOUT" -ForegroundColor Red
    return $false
}

function Test-DeploymentHealthy {
    param([string]$Name)
    $ready = kubectl get deployment $Name -n $namespace -o jsonpath='{.status.readyReplicas}' 2>$null
    return ($ready -ge 1)
}

# ============================================================================
# PIPELINE STAGES
# ============================================================================

function Invoke-Lint {
    if ($SkipLint) { Write-Step "LINT" "Skipped (-SkipLint)" "DarkGray"; return $true }
    Write-Step "LINT" "Running ESLint..."
    if ($DryRun) { Write-Detail "npm run lint" -Status "DRY"; return $true }

    # Use cmd /c to isolate Node stderr from PowerShell's ErrorActionPreference
    $lintOutput = cmd /c "npm run lint 2>&1"
    if ($LASTEXITCODE -ne 0) {
        $lintOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Detail "Lint failed. Fix errors before deploying." -Status "FAIL"
        return $false
    }
    Write-Detail "Lint passed"
    return $true
}

function Invoke-Tests {
    if ($SkipTests) { Write-Step "TEST" "Skipped (-SkipTests)" "DarkGray"; return $true }
    Write-Step "TEST" "Running vitest..."
    if ($DryRun) { Write-Detail "npm test" -Status "DRY"; return $true }

    # Use cmd /c to isolate Node/vitest stderr from PowerShell's ErrorActionPreference.
    # Vitest writes test names and progress to stderr which PowerShell treats as
    # terminating errors when $ErrorActionPreference = "Stop".
    $testOutput = cmd /c "npm test 2>&1"
    if ($LASTEXITCODE -ne 0) {
        $testOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        Write-Detail "Tests failed. Fix before deploying." -Status "FAIL"
        return $false
    }

    # Extract summary line
    $summaryLine = $testOutput | Where-Object { $_ -match "Tests\s+\d+" } | Select-Object -Last 1
    if ($summaryLine) { Write-Detail "$summaryLine" } else { Write-Detail "All tests passed" }
    return $true
}

function Invoke-DockerBuild {
    param([array]$Services, [string]$Tag = "latest")
    if ($NoBuild) { Write-Step "BUILD" "Skipped (-NoBuild)" "DarkGray"; return $true }

    Write-Step "BUILD" "Building Docker images (tag: $Tag)..."
    if ($DryRun) {
        foreach ($svc in $Services) { Write-Detail "$($svc.Image):$Tag" -Status "DRY" }
        return $true
    }

    $buildStart = Get-Date
    $failed = @()
    $env:DOCKER_CLI_HINTS = "false"

    foreach ($svc in $Services) {
        Write-Host "  [BUILD] $($svc.Image):$Tag" -ForegroundColor White -NoNewline
        cmd /c "docker build -t `"$($svc.Image):$Tag`" -f `"$($svc.Dir)/Dockerfile`" . > nul 2>&1"
        if ($LASTEXITCODE -ne 0) {
            Write-Host " FAIL" -ForegroundColor Red
            $failed += $svc.Name
        } else {
            Write-Host " OK" -ForegroundColor Green
        }
    }

    $duration = [math]::Round(((Get-Date) - $buildStart).TotalSeconds, 1)
    $passed = $Services.Count - $failed.Count
    Write-Host "  Built $passed/$($Services.Count) in ${duration}s" -ForegroundColor DarkGray

    if ($failed.Count -gt 0) {
        Write-Detail "Failed: $($failed -join ', ')" -Status "FAIL"
        return $false
    }
    return $true
}

# ============================================================================
# COMMAND: deploy (blue/production stack)
# ============================================================================

function Invoke-Deploy {
    $services = Get-FilteredServices

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  TempEdge Deploy (Production)" -ForegroundColor Cyan
    Write-Host "==========================================`n" -ForegroundColor Cyan

    # Stage 1: Lint
    if (-not (Invoke-Lint)) { exit 1 }

    # Stage 2: Test
    if (-not (Invoke-Tests)) { exit 1 }

    # Stage 3: Build
    if (-not (Invoke-DockerBuild -Services $services -Tag "latest")) { exit 1 }

    # Stage 4: Apply K8s
    Write-Step "DEPLOY" "Applying K8s resources..."
    $prevErrorPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    # Base infrastructure
    foreach ($manifest in $K8sBaseManifests) {
        if (Test-Path $manifest) {
            Invoke-Kubectl "-apply -f $manifest" -Silent | Out-Null
        }
    }

    # VPN configmap
    $ovpnFile = Get-ChildItem "k8s/*.ovpn" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ovpnFile) {
        Invoke-Kubectl "delete configmap nordvpn-ovpn -n $namespace --ignore-not-found" -Silent | Out-Null
        Invoke-Kubectl "create configmap nordvpn-ovpn -n $namespace --from-file=nordvpn.ovpn=$($ovpnFile.FullName)" -Silent | Out-Null
        Write-Detail "VPN config (nordvpn-ovpn)"
    }
    Write-Detail "Base resources (namespace, config, secrets, PVC)"

    # Layered deployment
    $layers = Get-LayeredServices -Services $services
    foreach ($layerEntry in $layers) {
        $layerNum = $layerEntry.Key
        $layerSvcs = $layerEntry.Value
        $layerNames = @("Foundation (no deps)", "Depends on data-svc", "Depends on L0+L1", "Depends on all")
        Write-Host "`n  Layer $layerNum - $($layerNames[$layerNum])" -ForegroundColor Cyan

        foreach ($svc in $layerSvcs) {
            $manifest = "k8s/$($svc.Name).yaml"
            if (Test-Path $manifest) {
                Invoke-Kubectl "apply -f $manifest" -Silent | Out-Null
                Invoke-Kubectl "rollout restart deployment/$($svc.Name) -n $namespace" -Silent | Out-Null
                Write-Detail "$($svc.Name)"
            }
        }

        # Wait for layer
        foreach ($svc in $layerSvcs) {
            Wait-ForDeployment -Name $svc.Name | Out-Null
        }
    }

    # Ensure service selectors are correct (prevent stale green selectors)
    Write-Step "VERIFY" "Ensuring service selectors match production pods..."
    foreach ($svc in $ServiceRegistry) {
        if ($svc.Port -eq 0) { continue }
        $patch = "{`"spec`":{`"selector`":{`"app`":`"tempedge`",`"component`":`"$($svc.Name)`"}}}"
        Invoke-Kubectl "patch svc $($svc.Name) -n $namespace -p '$patch'" -Silent | Out-Null
    }
    Write-Detail "All production service selectors verified"

    $ErrorActionPreference = $prevErrorPref
    Invoke-ShowStatus
}

# ============================================================================
# COMMAND: green (deploy isolated green stack)
# ============================================================================

function Invoke-DeployGreen {
    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  TempEdge Deploy (Green Stack)" -ForegroundColor Cyan
    Write-Host "==========================================`n" -ForegroundColor Cyan

    # Stage 1: Lint
    if (-not (Invoke-Lint)) { exit 1 }

    # Stage 2: Test
    if (-not (Invoke-Tests)) { exit 1 }

    # Stage 3: Build with :green tag
    if (-not (Invoke-DockerBuild -Services $ServiceRegistry -Tag "green")) { exit 1 }

    # Stage 4: Generate and apply green manifests
    Write-Step "GENERATE" "Generating green K8s manifests..."
    if (-not $DryRun) {
        & "$repoRoot\generate-green-manifests.ps1"
    } else {
        Write-Detail "generate-green-manifests.ps1" -Status "DRY"
    }

    Write-Step "DEPLOY" "Applying green stack..."
    $prevErrorPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    # Apply green manifests in dependency order (PVC first, then services)
    $greenOrder = @(
        "k8s/green/pvc-green.yaml",
        "k8s/green/data-svc-green.yaml",
        "k8s/green/weather-svc-green.yaml",
        "k8s/green/market-svc-green.yaml",
        "k8s/green/liquidity-svc-green.yaml",
        "k8s/green/trading-svc-green.yaml",
        "k8s/green/dashboard-svc-green.yaml",
        "k8s/green/monitor-green.yaml"
    )

    foreach ($manifest in $greenOrder) {
        if (Test-Path $manifest) {
            $name = [System.IO.Path]::GetFileNameWithoutExtension($manifest)
            Invoke-Kubectl "apply -f $manifest" -Silent | Out-Null
            Write-Detail "$name"
        }
    }

    # Force pod recreation: image tag (:green) is the same, so K8s won't rolling-restart
    # unless we explicitly tell it to pick up the newly-built images.
    foreach ($svc in $ServiceRegistry) {
        Invoke-Kubectl "rollout restart deployment/$($svc.Name)-green -n tempedge" -Silent | Out-Null
    }

    # Wait for all green services including monitor
    Write-Step "WAIT" "Waiting for green pods..."
    foreach ($svc in $ServiceRegistry) {
        Wait-ForDeployment -Name "$($svc.Name)-green" | Out-Null
    }

    $ErrorActionPreference = $prevErrorPref

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  Green Stack Ready!" -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Blue (production):  http://localhost:30301" -ForegroundColor White
    Write-Host "  Green (testing):    http://localhost:30302" -ForegroundColor Green
    Write-Host ""
    Write-Host "  All 7 services deployed (including monitor)." -ForegroundColor White
    Write-Host "  TRADING_MODE in configmap controls live execution." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor DarkGray
    Write-Host "    .\pipeline.ps1 promote     # Swap production to green" -ForegroundColor DarkGray
    Write-Host "    .\pipeline.ps1 teardown     # Remove green stack" -ForegroundColor DarkGray
}

# ============================================================================
# COMMAND: promote (green -> production)
# ============================================================================

function Invoke-Promote {
    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  TempEdge Green -> Production Promotion" -ForegroundColor Cyan
    Write-Host "==========================================`n" -ForegroundColor Cyan

    # Stage 1: Validate green health
    Write-Step "1/5" "Validating green pod health..."
    $greenDeps = $ServiceRegistry | ForEach-Object { "$($_.Name)-green" }
    $allHealthy = $true

    foreach ($dep in $greenDeps) {
        if (Test-DeploymentHealthy -Name $dep) {
            Write-Detail "$dep (healthy)"
        } else {
            Write-Detail "$dep is NOT ready" -Status "FAIL"
            $allHealthy = $false
        }
    }

    if (-not $allHealthy) {
        Write-Host "`n  Not all green pods are healthy." -ForegroundColor Red
        if (-not $Force) {
            $answer = Read-Host "  Continue anyway? (y/N)"
            if ($answer -ne "y") { exit 1 }
        }
    } else {
        Write-Detail "All green pods healthy"
    }

    # Stage 2: Re-tag Docker images
    Write-Step "2/5" "Re-tagging green images -> latest..."
    foreach ($svc in $ServiceRegistry) {
        $cmd = "docker tag $($svc.Image):green $($svc.Image):latest"
        if ($DryRun) {
            Write-Detail $cmd -Status "DRY"
        } else {
            Invoke-Expression $cmd
            if ($LASTEXITCODE -ne 0) {
                Write-Detail "Failed to tag $($svc.Image)" -Status "FAIL"
                exit 1
            }
            Write-Detail "$($svc.Image):green -> :latest"
        }
    }

    # Stage 3: Scale up production with new images + fix selectors
    Write-Step "3/5" "Rolling out production deployments..."
    foreach ($svc in $ServiceRegistry) {
        if ($DryRun) {
            Write-Detail "scale + restart $($svc.Name)" -Status "DRY"
        } else {
            kubectl scale "deployment/$($svc.Name)" -n $namespace --replicas=1 2>&1 | Out-Null
            kubectl rollout restart "deployment/$($svc.Name)" -n $namespace 2>&1 | Out-Null
            Write-Detail "$($svc.Name) scaled + restarted"
        }
    }

    # Stage 4: Wait for production readiness
    Write-Step "4/5" "Waiting for production pods..."
    foreach ($svc in $ServiceRegistry) {
        if (-not (Wait-ForDeployment -Name $svc.Name -TimeoutSec 120)) {
            Write-Detail "Check: kubectl logs deployment/$($svc.Name) -n $namespace" -Status "WARN"
        }
    }

    # CRITICAL: Fix service selectors to point at production (blue) pods
    # This prevents the stale-selector bug where selectors get left pointing
    # at green component labels after a previous promote attempt.
    Write-Step "FIX" "Ensuring service selectors point to production pods..."
    foreach ($svc in $ServiceRegistry) {
        if ($svc.Port -eq 0) { continue }  # monitor has no service
        $svcName = $svc.Name
        $patchObj = @{ spec = @{ selector = @{ app = "tempedge"; component = $svcName } } }
        $patchJson = $patchObj | ConvertTo-Json -Depth 5 -Compress
        $patchFile = [System.IO.Path]::GetTempFileName()
        Set-Content -Path $patchFile -Value $patchJson -NoNewline
        if ($DryRun) {
            Write-Detail "patch svc $svcName selector -> component:$svcName" -Status "DRY"
        } else {
            kubectl patch svc $svcName -n $namespace --type=merge --patch-file $patchFile 2>&1 | Out-Null
            Write-Detail "$svcName selector -> component:$svcName"
        }
        Remove-Item $patchFile -ErrorAction SilentlyContinue
    }

    # Stage 5: Scale down green
    Write-Step "5/5" "Scaling down green stack..."
    foreach ($svc in $ServiceRegistry) {
        $greenName = "$($svc.Name)-green"
        if ($DryRun) {
            Write-Detail "scale $greenName -> 0" -Status "DRY"
        } else {
            kubectl scale "deployment/$greenName" -n $namespace --replicas=0 2>&1 | Out-Null
            Write-Detail "$greenName -> 0 replicas"
        }
    }

    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  Promotion Complete!" -ForegroundColor Green
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  Dashboard: http://localhost:30301" -ForegroundColor White
    Write-Host ""

    if ($DryRun) { Write-Host "  ** DRY RUN -- no changes made **`n" -ForegroundColor Yellow }
}

# ============================================================================
# COMMAND: rollback (restore previous production images)
# ============================================================================

function Invoke-Rollback {
    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  TempEdge Rollback" -ForegroundColor Cyan
    Write-Host "==========================================`n" -ForegroundColor Cyan

    Write-Step "ROLLBACK" "Rolling back all production deployments to previous revision..."

    foreach ($svc in $ServiceRegistry) {
        if ($DryRun) {
            Write-Detail "kubectl rollout undo deployment/$($svc.Name)" -Status "DRY"
        } else {
            kubectl rollout undo "deployment/$($svc.Name)" -n $namespace 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Detail "$($svc.Name) rolled back"
            } else {
                Write-Detail "$($svc.Name) rollback failed (no previous revision?)" -Status "WARN"
            }
        }
    }

    Write-Step "WAIT" "Waiting for pods..."
    foreach ($svc in $ServiceRegistry) {
        Wait-ForDeployment -Name $svc.Name -TimeoutSec 120 | Out-Null
    }

    Write-Host "`n  Rollback complete. Dashboard: http://localhost:30301`n" -ForegroundColor Green
}

# ============================================================================
# COMMAND: teardown
# ============================================================================

function Invoke-Teardown {
    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  TempEdge Teardown" -ForegroundColor Cyan
    Write-Host "==========================================`n" -ForegroundColor Cyan

    if ($Full) {
        if (-not $Force) {
            $answer = Read-Host "  This will delete EVERYTHING including the namespace and PVC. Continue? (y/N)"
            if ($answer -ne "y") { exit 0 }
        }

        # Delete green stack first
        Write-Step "TEARDOWN" "Removing green stack..."
        foreach ($svc in $ServiceRegistry) {
            $greenName = "$($svc.Name)-green"
            Invoke-Kubectl "delete deployment $greenName -n $namespace --ignore-not-found" -Silent | Out-Null
            Invoke-Kubectl "delete service $greenName -n $namespace --ignore-not-found" -Silent | Out-Null
            Write-Detail $greenName
        }

        # Delete production stack
        Write-Step "TEARDOWN" "Removing production stack..."
        $serviceManifests = $ServiceRegistry | ForEach-Object { "k8s/$($_.Name).yaml" }
        foreach ($manifest in $serviceManifests) {
            if (Test-Path $manifest) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($manifest)
                Invoke-Kubectl "delete -f $manifest --ignore-not-found" -Silent | Out-Null
                Write-Detail $name
            }
        }

        # Delete base resources
        Write-Step "TEARDOWN" "Removing base resources..."
        foreach ($manifest in ($K8sBaseManifests | Sort-Object -Descending)) {
            if (Test-Path $manifest) {
                $name = [System.IO.Path]::GetFileNameWithoutExtension($manifest)
                Invoke-Kubectl "delete -f $manifest --ignore-not-found" -Silent | Out-Null
                Write-Detail $name
            }
        }

        Write-Host "`n  Full teardown complete.`n" -ForegroundColor Green
    } else {
        # Green-only teardown
        Write-Step "TEARDOWN" "Removing green stack..."
        foreach ($svc in $ServiceRegistry) {
            $greenName = "$($svc.Name)-green"
            Invoke-Kubectl "delete deployment $greenName -n $namespace --ignore-not-found" -Silent | Out-Null
            Invoke-Kubectl "delete service $greenName -n $namespace --ignore-not-found" -Silent | Out-Null
            Write-Detail $greenName
        }
        # Clean up green PVC
        Invoke-Kubectl "delete pvc tempedge-output-green -n $namespace --ignore-not-found" -Silent | Out-Null
        Write-Detail "tempedge-output-green (PVC)"
        Write-Host "`n  Green stack removed. Production untouched.`n" -ForegroundColor Green
    }
}

# ============================================================================
# COMMAND: status
# ============================================================================

function Invoke-ShowStatus {
    Write-Host "`n==========================================" -ForegroundColor Cyan
    Write-Host "  TempEdge Cluster Status" -ForegroundColor Cyan
    Write-Host "==========================================`n" -ForegroundColor Cyan

    # Pods
    Write-Host "  Pods:" -ForegroundColor Yellow
    $pods = kubectl get pods -n $namespace --no-headers 2>&1
    if ($pods) {
        $pods | ForEach-Object { Write-Host "    $_" -ForegroundColor White }
    } else {
        Write-Host "    (none)" -ForegroundColor DarkGray
    }

    # Services
    Write-Host "`n  Services:" -ForegroundColor Yellow
    $svcs = kubectl get svc -n $namespace --no-headers 2>&1
    if ($svcs) {
        $svcs | ForEach-Object { Write-Host "    $_" -ForegroundColor White }
    } else {
        Write-Host "    (none)" -ForegroundColor DarkGray
    }

    # Service selector health (detect stale green selectors)
    Write-Host "`n  Selector Health:" -ForegroundColor Yellow
    foreach ($svc in $ServiceRegistry) {
        if ($svc.Port -eq 0) { continue }
        $selector = kubectl get svc $svc.Name -n $namespace -o jsonpath='{.spec.selector.component}' 2>$null
        if ($selector -eq $svc.Name) {
            Write-Host "    $($svc.Name) -> component:$selector" -ForegroundColor Green
        } elseif ($selector -match "green") {
            Write-Host "    $($svc.Name) -> component:$selector [STALE - points at green!]" -ForegroundColor Red
        } elseif ($selector) {
            Write-Host "    $($svc.Name) -> component:$selector [UNKNOWN]" -ForegroundColor Yellow
        } else {
            Write-Host "    $($svc.Name) -> (no service found)" -ForegroundColor DarkGray
        }
    }

    Write-Host "`n  Dashboard: http://localhost:30301" -ForegroundColor White
    Write-Host ""
}

# ============================================================================
# MAIN DISPATCH
# ============================================================================

Write-Host ""
Write-Host "  ___________                    ___________    .___" -ForegroundColor Cyan
Write-Host "  \__    ___/___   _____ ______  \_   _____/  __| _/ ____   ____" -ForegroundColor Cyan
Write-Host "    |    | /  _ \ /     \\\____ \  |    __)_  / __ | / ___\_/ __ \" -ForegroundColor Cyan
Write-Host "    |    |(  <_> )  Y Y  \  |_> > |        \/ /_/ |/ /_/  >  ___/" -ForegroundColor Cyan
Write-Host "    |____| \____/|__|_|  /   __/ /_______  /\____ |\___  / \___  >" -ForegroundColor Cyan
Write-Host "                       \/|__|            \/      \/_____/      \/" -ForegroundColor Cyan
Write-Host ""

if ($DryRun) {
    Write-Host "  ** DRY RUN MODE -- no changes will be made **`n" -ForegroundColor Yellow
}

switch ($Command) {
    "deploy"   { Invoke-Deploy }
    "green"    { Invoke-DeployGreen }
    "promote"  { Invoke-Promote }
    "rollback" { Invoke-Rollback }
    "teardown" { Invoke-Teardown }
    "status"   { Invoke-ShowStatus }
}
