# Vérifie que le contournement du certificat est limité aux appels LCU sur 127.0.0.1.
# Lancé par run.sh pendant que fake_lcu.py tourne (certificat auto-signé pour CN=127.0.0.1).
param([Parameter(Mandatory = $true)][string]$LcuLockfile)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path (Split-Path -Parent $here) 'lolhelper-draft.ps1') -NoMain

$fail = 0
function Check([string]$Name, [bool]$Ok, [string]$Info = '') {
    if ($Ok) { Write-Host "ok   $Name" } else { $script:fail++; Write-Host "ECHEC $Name $Info" -ForegroundColor Red }
}

$cand = ConvertFrom-Lockfile ([IO.File]::ReadAllText($LcuLockfile))
$conn = New-LcuConnection $cand
$port = $cand.Port

# 1. Appel LCU : certificat auto-signé accepté (PowerShell 7 : -SkipCertificateCheck sur cet appel).
$r = Invoke-Lcu $conn '/lol-summoner/v1/current-summoner'
Check 'LCU 127.0.0.1 accepté' ($r.Status -eq 200 -or $r.Status -eq 404) "status=$($r.Status) $($r.Error)"

# 2. Appel "site" vers le même serveur auto-signé : la validation TLS doit échouer.
$s = Invoke-Site -SiteUrl "https://localhost:$port" -Query 'r=meta' -TimeoutSec 5
Check 'site auto-signé refusé (validation normale)' (-not $s.Ok -and $s.Status -eq 0) "ok=$($s.Ok) status=$($s.Status)"
$s = Invoke-Site -SiteUrl "https://127.0.0.1:$port" -Query 'r=meta' -TimeoutSec 5
Check 'site même sur 127.0.0.1 : validation normale' (-not $s.Ok -and $s.Status -eq 0) "ok=$($s.Ok) status=$($s.Status)"

# 3. Chemin Windows PowerShell 5.1 : rappel ServicePointManager limité à 127.0.0.1 (HttpWebRequest).
if (-not ('LoLHelperCompanion.LcuCertificatePolicy' -as [type])) { Add-Type -TypeDefinition $script:LcuCertPolicySource -Language CSharp }
[LoLHelperCompanion.LcuCertificatePolicy]::Install()
function Get-WebStatus([string]$Url) {
    try {
        $req = [Net.HttpWebRequest]::Create($Url)
        $req.Headers['Authorization'] = $conn.Auth
        $req.Timeout = 5000
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return "http $code"
    } catch [Net.WebException] {
        if ($null -ne $_.Exception.Response) { return "http $([int]$_.Exception.Response.StatusCode)" }
        return "error $($_.Exception.Status)"
    }
}
$a = Get-WebStatus "https://127.0.0.1:$port/lol-gameflow/v1/gameflow-phase"
Check 'rappel 5.1 : 127.0.0.1 accepté' ($a -like 'http *') $a
$b = Get-WebStatus "https://localhost:$port/lol-gameflow/v1/gameflow-phase"
Check 'rappel 5.1 : localhost refusé' ($b -like 'error *') $b

if ($fail -gt 0) { exit 1 }
