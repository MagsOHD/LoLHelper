<#
.SYNOPSIS
    LoLHelper - compagnon "Draft en direct" (Windows).

.DESCRIPTION
    Lit la sélection des champions dans le client League of Legends (API locale LCU,
    requêtes GET uniquement) et l'envoie au site LoLHelper de votre groupe, qui affiche
    alors des conseils de draft. Aucune action n'est jamais effectuée dans le client.

    Compatible Windows PowerShell 5.1 et PowerShell 7. Aucune installation, aucun droit
    administrateur.

.PARAMETER Reset
    Efface la configuration enregistrée (adresse du site, mot de passe) et relance l'assistant.

.PARAMETER ConfigPath
    Fichier de configuration (par défaut %APPDATA%\LoLHelper\config.json).

.PARAMETER LockfilePath
    Chemin du fichier "lockfile" du client League (par défaut
    C:\Riot Games\League of Legends\lockfile, puis détection via le processus LeagueClientUx).

.PARAMETER MaxRunSeconds
    (Tests) Arrête le programme après ce nombre de secondes. 0 = jamais.

.PARAMETER NoMain
    (Tests) Charge uniquement les fonctions, sans lancer le programme.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1 -Reset
#>
[CmdletBinding()]
param(
    [switch]$Reset,
    [string]$ConfigPath = '',
    [string]$LockfilePath = '',
    [int]$MaxRunSeconds = 0,
    [switch]$NoMain
)

$ErrorActionPreference = 'Stop'

$script:CompanionVersion = '1.0.0'
$script:IsModernPowerShell = $PSVersionTable.PSVersion.Major -ge 6
$script:OnWindows = (-not $script:IsModernPowerShell) -or ($IsWindows -eq $true)
$script:DefaultLockfile = 'C:\Riot Games\League of Legends\lockfile'
$script:Positions = @('top', 'jungle', 'middle', 'bottom', 'utility')
$script:PhaseMap = @{
    'PLANNING'      = 'planning'
    'BAN_PICK'      = 'ban_pick'
    'FINALIZATION'  = 'finalization'
    'GAME_STARTING' = 'game_starting'
}
$script:PuuidPattern = '^[A-Za-z0-9_-]{40,100}$'  # même règle que l'API (RIOT_PUUID_PATTERN)

# Validation du certificat du client League (Windows PowerShell 5.1 uniquement).
# Le client League utilise un certificat auto-signé sur https://127.0.0.1:<port>.
# Ce rappel n'accepte un certificat invalide QUE pour une requête HttpWebRequest
# vers https://127.0.0.1 ; pour toute autre adresse (dont le site LoLHelper), la
# validation TLS normale de Windows s'applique (aucune erreur tolérée).
# C# 5 (compilateur intégré à .NET Framework) : pas de syntaxe récente.
$script:LcuCertPolicySource = @'
using System;
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

namespace LoLHelperCompanion
{
    public static class LcuCertificatePolicy
    {
        private static bool installed = false;

        public static void Install()
        {
            if (installed) { return; }
            ServicePointManager.ServerCertificateValidationCallback = Validate;
            installed = true;
        }

        public static bool IsLcuUri(Uri uri)
        {
            return uri != null
                && uri.IsAbsoluteUri
                && string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
                && uri.Host == "127.0.0.1";
        }

        public static bool Validate(object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors)
        {
            if (errors == SslPolicyErrors.None) { return true; }
            HttpWebRequest request = sender as HttpWebRequest;
            if (request != null && IsLcuUri(request.RequestUri)) { return true; }
            return false;
        }
    }
}
'@

# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------

function Write-Info([string]$Message, [string]$Color = 'Gray') {
    $time = (Get-Date).ToString('HH:mm:ss')
    Write-Host ("[{0}] {1}" -f $time, $Message) -ForegroundColor $Color
}

function Get-IntOrDefault($Value, [int]$Default = 0) {
    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { return $Default }
    try {
        $d = [double]$Value
    } catch {
        return $Default
    }
    if ([double]::IsNaN($d) -or $d -gt [int]::MaxValue -or $d -lt [int]::MinValue) { return $Default }
    return [int][Math]::Round($d)
}

function Get-ChampionKey($Value) {
    $k = Get-IntOrDefault $Value 0
    if ($k -lt 0 -or $k -gt 2000) { return 0 }
    return $k
}

function Get-SafePuuid($Value) {
    if ($null -eq $Value) { return '' }
    $s = [string]$Value
    if ($s -match $script:PuuidPattern) { return $s }
    return ''
}

function Get-UtcTimestamp {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-PlainText([Security.SecureString]$Secure) {
    if ($null -eq $Secure) { return '' }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Get-DefaultConfigPath {
    $base = $env:APPDATA
    if ([string]::IsNullOrEmpty($base)) {
        $base = Join-Path $HOME '.config'
    }
    return (Join-Path (Join-Path $base 'LoLHelper') 'config.json')
}

# ---------------------------------------------------------------------------
# Normalisation (fonctions pures, testées dans tests/unit.ps1)
# ---------------------------------------------------------------------------

<#
  Nettoie l'adresse du site saisie par l'utilisateur :
  "mon-domaine.fr/lolhelper/#/team/x" -> "https://mon-domaine.fr/lolhelper".
  Retourne $null si l'adresse est inutilisable.
#>
function Get-NormalizedSiteUrl([string]$Raw) {
    if ($null -eq $Raw) { return $null }
    $s = $Raw.Trim().Trim('"').Trim("'").Trim()
    if ($s -eq '') { return $null }
    if ($s -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') { $s = 'https://' + $s }
    $hash = $s.IndexOf('#')
    if ($hash -ge 0) { $s = $s.Substring(0, $hash) }
    $q = $s.IndexOf('?')
    if ($q -ge 0) { $s = $s.Substring(0, $q) }
    $s = $s -replace '/+$', ''
    $s = $s -replace '/api/index\.php$', ''
    $s = $s -replace '/index\.html?$', ''
    $s = $s -replace '/api$', ''
    $s = $s -replace '/+$', ''
    $uri = $null
    if (-not [Uri]::TryCreate($s, [UriKind]::Absolute, [ref]$uri)) { return $null }
    if ($uri.Scheme -ne 'https' -and $uri.Scheme -ne 'http') { return $null }
    if ([string]::IsNullOrEmpty($uri.Host)) { return $null }
    return $s
}

<# Lit le contenu d'un lockfile "LeagueClient:<pid>:<port>:<mot de passe>:<protocole>". #>
function ConvertFrom-Lockfile([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $parts = $Text.Trim().Split(':')
    if ($parts.Count -lt 5) { return $null }
    $port = Get-IntOrDefault $parts[2] 0
    $token = $parts[3]
    if ($port -lt 1 -or $port -gt 65535 -or [string]::IsNullOrEmpty($token)) { return $null }
    return @{ Port = $port; Token = $token }
}

<# Extrait --app-port et --remoting-auth-token de la ligne de commande de LeagueClientUx.exe. #>
function ConvertFrom-LeagueCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrEmpty($CommandLine)) { return $null }
    $portMatch = [regex]::Match($CommandLine, '--app-port=(\d+)')
    $tokenMatch = [regex]::Match($CommandLine, '--remoting-auth-token=([^\s"]+)')
    if (-not $portMatch.Success -or -not $tokenMatch.Success) { return $null }
    $port = Get-IntOrDefault $portMatch.Groups[1].Value 0
    if ($port -lt 1 -or $port -gt 65535) { return $null }
    return @{ Port = $port; Token = $tokenMatch.Groups[1].Value }
}

<# timer.phase du client -> phase du site ; $null si inconnue. #>
function ConvertTo-DraftPhase([string]$TimerPhase) {
    if ([string]::IsNullOrEmpty($TimerPhase)) { return $null }
    $key = $TimerPhase.ToUpperInvariant()
    if ($script:PhaseMap.ContainsKey($key)) { return $script:PhaseMap[$key] }
    return $null
}

<#
  Session de sélection des champions (LCU /lol-champ-select/v1/session) -> CompanionPayload.
  Ne garde AUCUNE donnée d'identité des adversaires (seulement cellule + champion).
  Retourne $null si la session n'est pas exploitable (spectateur, phase inconnue).
#>
function ConvertTo-CompanionPayload {
    param(
        [Parameter(Mandatory = $true)] $Session,
        [Parameter(Mandatory = $true)] [string]$Puuid,
        [int]$QueueId = 0,
        [string]$SentAt = ''
    )
    if ($null -eq $Session) { return $null }
    if ($Session.isSpectating -eq $true) { return $null }
    $timer = $Session.timer
    $phase = $null
    if ($null -ne $timer) { $phase = ConvertTo-DraftPhase ([string]$timer.phase) }
    if ($null -eq $phase) { return $null }

    $myTeam = New-Object 'System.Collections.Generic.List[object]'
    foreach ($m in @($Session.myTeam)) {
        if ($null -eq $m) { continue }
        if ($myTeam.Count -ge 5) { break }
        $pos = ''
        if ($null -ne $m.assignedPosition) { $pos = ([string]$m.assignedPosition).ToLowerInvariant() }
        if ($script:Positions -notcontains $pos) { $pos = '' }
        $myTeam.Add([ordered]@{
                cell         = Get-IntOrDefault $m.cellId 0
                puuid        = Get-SafePuuid $m.puuid
                champion_key = Get-ChampionKey $m.championId
                intent_key   = Get-ChampionKey $m.championPickIntent
                position     = $pos
            })
    }

    $theirTeam = New-Object 'System.Collections.Generic.List[object]'
    foreach ($m in @($Session.theirTeam)) {
        if ($null -eq $m) { continue }
        if ($theirTeam.Count -ge 5) { break }
        # Volontairement : ni puuid, ni summonerId, ni pseudo des adversaires.
        $theirTeam.Add([ordered]@{
                cell         = Get-IntOrDefault $m.cellId 0
                champion_key = Get-ChampionKey $m.championId
            })
    }

    $actions = New-Object 'System.Collections.Generic.List[object]'
    foreach ($turn in @($Session.actions)) {
        foreach ($a in @($turn)) {
            if ($null -eq $a) { continue }
            if ($actions.Count -ge 30) { break }
            $type = ([string]$a.type).ToLowerInvariant()
            if ($type -ne 'ban' -and $type -ne 'pick') { continue }
            $actions.Add([ordered]@{
                    type         = $type
                    champion_key = Get-ChampionKey $a.championId
                    completed    = ($a.completed -eq $true)
                    ally         = ($a.isAllyAction -eq $true)
                    cell         = Get-IntOrDefault $a.actorCellId 0
                    in_progress  = ($a.isInProgress -eq $true)
                })
        }
    }

    $bansMine = New-Object 'System.Collections.Generic.List[object]'
    $bansTheirs = New-Object 'System.Collections.Generic.List[object]'
    if ($null -ne $Session.bans) {
        foreach ($b in @($Session.bans.myTeamBans)) {
            if ($null -ne $b -and $bansMine.Count -lt 5) { $bansMine.Add((Get-ChampionKey $b)) }
        }
        foreach ($b in @($Session.bans.theirTeamBans)) {
            if ($null -ne $b -and $bansTheirs.Count -lt 5) { $bansTheirs.Add((Get-ChampionKey $b)) }
        }
    }
    if ($bansMine.Count -eq 0 -and $bansTheirs.Count -eq 0) {
        # Secours : certains modes ne remplissent pas session.bans -> bannissements terminés.
        foreach ($a in $actions) {
            if ($a.type -ne 'ban' -or -not $a.completed) { continue }
            if ($a.ally) {
                if ($bansMine.Count -lt 5) { $bansMine.Add($a.champion_key) }
            } elseif ($bansTheirs.Count -lt 5) {
                $bansTheirs.Add($a.champion_key)
            }
        }
    }

    $remaining = 0
    if ($null -ne $timer -and $timer.isInfinite -ne $true) {
        $remaining = Get-IntOrDefault $timer.adjustedTimeLeftInPhase 0
        if ($remaining -lt 0) { $remaining = 0 }
        if ($remaining -gt 3600000) { $remaining = 3600000 }
    }

    if ([string]::IsNullOrEmpty($SentAt)) { $SentAt = Get-UtcTimestamp }

    return [ordered]@{
        version            = 1
        puuid              = $Puuid
        phase              = $phase
        queue_id           = $QueueId
        local_cell         = Get-IntOrDefault $Session.localPlayerCellId 0
        my_team            = $myTeam.ToArray()
        their_team         = $theirTeam.ToArray()
        bans               = [ordered]@{ mine = $bansMine.ToArray(); theirs = $bansTheirs.ToArray() }
        actions            = $actions.ToArray()
        timer_remaining_ms = $remaining
        sent_at            = $SentAt
    }
}

<# Message "fin de sélection" (phase none) : le site arrête d'afficher les données en direct. #>
function New-NonePayload([string]$Puuid, [int]$QueueId = 0, [int]$LocalCell = 0, [string]$SentAt = '') {
    if ([string]::IsNullOrEmpty($SentAt)) { $SentAt = Get-UtcTimestamp }
    return [ordered]@{
        version            = 1
        puuid              = $Puuid
        phase              = 'none'
        queue_id           = $QueueId
        local_cell         = $LocalCell
        my_team            = @()
        their_team         = @()
        bans               = [ordered]@{ mine = @(); theirs = @() }
        actions            = @()
        timer_remaining_ms = 0
        sent_at            = $SentAt
    }
}

function ConvertTo-PayloadJson($Payload) {
    return (ConvertTo-Json -InputObject $Payload -Depth 6 -Compress)
}

<# Empreinte du contenu (sans l'horodatage ni le chrono) : on n'envoie que si elle change. #>
function Get-PayloadKey($Payload) {
    if ($null -eq $Payload) { return '' }
    $copy = [ordered]@{}
    foreach ($k in $Payload.Keys) {
        if ($k -ne 'sent_at' -and $k -ne 'timer_remaining_ms') { $copy[$k] = $Payload[$k] }
    }
    return (ConvertTo-PayloadJson $copy)
}

function Get-PayloadSummary($Payload) {
    $allies = @($Payload.my_team | Where-Object { $_.champion_key -gt 0 }).Count
    $enemies = @($Payload.their_team | Where-Object { $_.champion_key -gt 0 }).Count
    $bans = @($Payload.bans.mine | Where-Object { $_ -gt 0 }).Count + @($Payload.bans.theirs | Where-Object { $_ -gt 0 }).Count
    return ("phase {0} - {1} champion(s) allié(s), {2} ennemi(s), {3} bannissement(s)" -f $Payload.phase, $allies, $enemies, $bans)
}

# ---------------------------------------------------------------------------
# Configuration (mot de passe chiffré avec DPAPI : lisible seulement par votre
# compte Windows sur ce PC)
# ---------------------------------------------------------------------------

function Read-CompanionConfig([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $raw = [IO.File]::ReadAllText($Path)
        $obj = ConvertFrom-Json $raw
    } catch {
        Write-Info "Configuration illisible ($Path) : elle va être recréée." 'Yellow'
        return $null
    }
    $site = Get-NormalizedSiteUrl ([string]$obj.site_url)
    if ($null -eq $site) { return $null }
    $password = ''
    $protected = [string]$obj.password_protected
    if ($protected -ne '') {
        try {
            $password = ConvertTo-PlainText (ConvertTo-SecureString $protected)
        } catch {
            Write-Info "Le mot de passe enregistré ne peut pas être déchiffré (autre compte Windows ou autre PC ?) : la configuration va être recréée." 'Yellow'
            return $null
        }
    }
    $lock = ''
    if ($null -ne $obj.lockfile_path) { $lock = [string]$obj.lockfile_path }
    return @{ SiteUrl = $site; Password = $password; LockfilePath = $lock }
}

function Save-CompanionConfig([string]$Path, [string]$SiteUrl, [string]$Password, [string]$LockfilePathValue = '') {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $protected = ''
    if ($Password -ne '') {
        $protected = ConvertFrom-SecureString (ConvertTo-SecureString $Password -AsPlainText -Force)
    }
    $obj = [ordered]@{
        version            = 1
        site_url           = $SiteUrl
        password_protected = $protected
        lockfile_path      = $LockfilePathValue
    }
    $json = ConvertTo-Json -InputObject $obj -Depth 3
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------------------
# Site LoLHelper (validation TLS normale, jamais contournée)
# ---------------------------------------------------------------------------

function Get-HttpStatusCode($ErrorRecord) {
    $resp = $null
    try { $resp = $ErrorRecord.Exception.Response } catch { $resp = $null }
    if ($null -eq $resp) { return 0 }
    try { return [int]$resp.StatusCode } catch { return 0 }
}

function Get-ErrorDetail($ErrorRecord) {
    $text = $null
    if ($null -ne $ErrorRecord.ErrorDetails) { $text = $ErrorRecord.ErrorDetails.Message }
    if (-not [string]::IsNullOrEmpty($text)) {
        try {
            $j = ConvertFrom-Json $text
            if ($null -ne $j.detail) { return [string]$j.detail }
        } catch { }
    }
    return ''
}

function Invoke-Site {
    param(
        [Parameter(Mandatory = $true)] [string]$SiteUrl,
        [string]$Password = '',
        [string]$Method = 'Get',
        [string]$Query = '',
        [string]$Json = $null,
        [int]$TimeoutSec = 15
    )
    $headers = @{ 'Accept' = 'application/json' }
    if ($Password -ne '') { $headers['X-App-Password'] = $Password }
    $params = @{
        Uri             = "$SiteUrl/api/index.php?$Query"
        Method          = $Method
        Headers         = $headers
        TimeoutSec      = $TimeoutSec
        UseBasicParsing = $true
        ErrorAction     = 'Stop'
    }
    if ($null -ne $Json -and $Json -ne '') {
        $params.Body = [Text.Encoding]::UTF8.GetBytes($Json)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    try {
        $body = Invoke-RestMethod @params
        return @{ Ok = $true; Status = 200; Body = $body; Detail = ''; Error = '' }
    } catch {
        return @{
            Ok     = $false
            Status = (Get-HttpStatusCode $_)
            Body   = $null
            Detail = (Get-ErrorDetail $_)
            Error  = $_.Exception.Message
        }
    }
}

function Test-SiteMeta([string]$SiteUrl) {
    $r = Invoke-Site -SiteUrl $SiteUrl -Query 'r=meta' -TimeoutSec 10
    if ($r.Ok -and $null -ne $r.Body -and $null -ne $r.Body.password_required) {
        return @{ Ok = $true; PasswordRequired = ($r.Body.password_required -eq $true); Error = '' }
    }
    $err = $r.Error
    if ($r.Ok) { $err = "réponse inattendue (est-ce bien l'adresse du site LoLHelper ?)" }
    elseif ($r.Status -gt 0) { $err = "HTTP $($r.Status) $($r.Detail)" }
    return @{ Ok = $false; PasswordRequired = $true; Error = $err }
}

<# Vérifie le mot de passe sans lire de données : seul le code 401 signifie "refusé". #>
function Test-SitePassword([string]$SiteUrl, [string]$Password) {
    $r = Invoke-Site -SiteUrl $SiteUrl -Password $Password -Query 'r=live-draft' -TimeoutSec 10
    if ($r.Status -eq 401) { return 'refused' }
    if ($r.Status -eq 404 -and $r.Detail -eq 'Route inconnue.') { return 'outdated' }
    if ($r.Ok -or $r.Status -ge 400) { return 'ok' }
    return 'unreachable'
}

function Invoke-ConfigWizard([string]$Path) {
    $redirected = $false
    try { $redirected = [Console]::IsInputRedirected } catch { $redirected = $false }
    Write-Host ''
    Write-Host '=== Première configuration ===' -ForegroundColor Cyan
    Write-Host "Indiquez l'adresse de votre site LoLHelper (celle que vous ouvrez dans le navigateur)."
    Write-Host 'Exemple : https://mon-domaine.fr/lolhelper'
    $site = $null
    $meta = $null
    while ($null -eq $site) {
        $raw = Read-Host 'Adresse du site'
        if ($null -eq $raw) { throw 'Configuration annulée.' }
        $candidate = Get-NormalizedSiteUrl $raw
        if ($null -eq $candidate) {
            Write-Host 'Adresse invalide, réessayez.' -ForegroundColor Yellow
            if ($redirected -and [string]::IsNullOrEmpty($raw)) { throw 'Configuration annulée.' }
            continue
        }
        if ($candidate.StartsWith('http://') -and $candidate -notmatch '^http://(127\.0\.0\.1|localhost)(:|/|$)') {
            # Préférer https:// quand le site le permet (mot de passe chiffré, pas de redirection du PUT).
            $secure = 'https://' + $candidate.Substring(7)
            if ((Test-SiteMeta $secure).Ok) {
                Write-Host "Le site répond aussi en https:// : utilisation de $secure"
                $candidate = $secure
            }
        }
        Write-Host "Test de $candidate ..."
        $meta = Test-SiteMeta $candidate
        if ($meta.Ok) {
            Write-Host 'Site joignable.' -ForegroundColor Green
            if ($candidate.StartsWith('http://') -and $candidate -notmatch '^http://(127\.0\.0\.1|localhost)(:|/|$)') {
                Write-Host "Attention : adresse en http:// (non chiffrée), le mot de passe circulera en clair. Préférez https://." -ForegroundColor Yellow
            }
            $site = $candidate
        } else {
            Write-Host "Site injoignable : $($meta.Error)" -ForegroundColor Yellow
            $answer = Read-Host 'Enregistrer quand même cette adresse ? (o/N)'
            if ($answer -match '^(o|oui|y|yes)$') { $site = $candidate; $meta = @{ PasswordRequired = $true } }
        }
    }

    $password = ''
    if ($meta.PasswordRequired) {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            if ($redirected) {
                $password = [string](Read-Host 'Mot de passe du site')
            } else {
                $password = ConvertTo-PlainText (Read-Host 'Mot de passe du site' -AsSecureString)
            }
            $check = Test-SitePassword $site $password
            if ($check -eq 'refused') {
                Write-Host 'Mot de passe refusé par le site.' -ForegroundColor Yellow
                if ($attempt -eq 3) { throw 'Mot de passe refusé trois fois : configuration annulée.' }
                continue
            }
            if ($check -eq 'ok') { Write-Host 'Mot de passe accepté.' -ForegroundColor Green }
            elseif ($check -eq 'outdated') { Write-Host "Mot de passe accepté, mais le site ne connaît pas encore la draft en direct : mettez-le à jour." -ForegroundColor Yellow }
            else { Write-Host 'Impossible de vérifier le mot de passe pour le moment (il sera enregistré tel quel).' -ForegroundColor Yellow }
            break
        }
    } else {
        Write-Host "Ce site ne demande pas de mot de passe."
    }

    Save-CompanionConfig -Path $Path -SiteUrl $site -Password $password
    Write-Host "Configuration enregistrée dans $Path (mot de passe chiffré pour votre compte Windows)." -ForegroundColor Green
    Write-Host "Pour la modifier plus tard : relancez avec -Reset (Lancer-LoLHelper-Draft.bat -Reset)."
    Write-Host ''
    return @{ SiteUrl = $site; Password = $password; LockfilePath = '' }
}

# ---------------------------------------------------------------------------
# Client League (LCU) : GET uniquement, certificat accepté seulement pour 127.0.0.1
# ---------------------------------------------------------------------------

function Initialize-Tls {
    if ($script:IsModernPowerShell) { return }
    # Windows PowerShell 5.1 : activer TLS 1.2 (site) et installer le rappel limité à 127.0.0.1.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::Expect100Continue = $false
    if (-not ('LoLHelperCompanion.LcuCertificatePolicy' -as [type])) {
        Add-Type -TypeDefinition $script:LcuCertPolicySource -Language CSharp
    }
    [LoLHelperCompanion.LcuCertificatePolicy]::Install()
}

function Read-SharedTextFile([string]$Path) {
    # Le client garde le lockfile ouvert : lecture avec partage complet.
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $reader = New-Object IO.StreamReader($fs)
        return $reader.ReadToEnd()
    } finally {
        $fs.Dispose()
    }
}

<# Connexions possibles au client, dans l'ordre : lockfile(s) puis processus LeagueClientUx. #>
function Get-LcuCandidates([string[]]$LockfilePaths) {
    $list = New-Object 'System.Collections.Generic.List[object]'
    $seen = @{}
    foreach ($p in $LockfilePaths) {
        if ([string]::IsNullOrEmpty($p) -or $seen.ContainsKey($p)) { continue }
        $seen[$p] = $true
        try {
            if (Test-Path -LiteralPath $p) {
                $c = ConvertFrom-Lockfile (Read-SharedTextFile $p)
                if ($null -ne $c) { $c.Source = "lockfile $p"; $list.Add($c) }
            }
        } catch { }
    }
    if ($script:OnWindows) {
        $procs = @()
        try {
            $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'LeagueClientUx.exe'" -ErrorAction Stop)
        } catch {
            try { $procs = @(Get-WmiObject -Class Win32_Process -Filter "Name = 'LeagueClientUx.exe'" -ErrorAction Stop) } catch { $procs = @() }
        }
        foreach ($proc in $procs) {
            if ($null -eq $proc) { continue }
            $c = ConvertFrom-LeagueCommandLine ([string]$proc.CommandLine)
            if ($null -ne $c) {
                $c.Source = 'processus LeagueClientUx'
                $list.Add($c)
            } elseif ($proc.ExecutablePath) {
                $lf = Join-Path (Split-Path -Parent ([string]$proc.ExecutablePath)) 'lockfile'
                try {
                    if (-not $seen.ContainsKey($lf) -and (Test-Path -LiteralPath $lf)) {
                        $c = ConvertFrom-Lockfile (Read-SharedTextFile $lf)
                        if ($null -ne $c) { $c.Source = "lockfile $lf"; $list.Add($c) }
                    }
                } catch { }
            } else {
                $script:ElevatedClientHint = $true
            }
        }
    }
    return , $list.ToArray()
}

function New-LcuConnection($Candidate) {
    $bytes = [Text.Encoding]::ASCII.GetBytes('riot:' + $Candidate.Token)
    return @{
        Port   = $Candidate.Port
        Auth   = 'Basic ' + [Convert]::ToBase64String($bytes)
        Source = $Candidate.Source
    }
}

<# GET sur l'API locale du client. Status 0 = client injoignable. #>
function Invoke-Lcu($Connection, [string]$Path) {
    $params = @{
        Uri             = "https://127.0.0.1:$($Connection.Port)$Path"
        Method          = 'Get'
        Headers         = @{ 'Authorization' = $Connection.Auth; 'Accept' = 'application/json' }
        TimeoutSec      = 5
        UseBasicParsing = $true
        ErrorAction     = 'Stop'
    }
    # PowerShell 7 : certificat auto-signé accepté uniquement pour cet appel vers 127.0.0.1.
    if ($script:IsModernPowerShell) { $params.SkipCertificateCheck = $true }
    try {
        $body = Invoke-RestMethod @params
        return @{ Status = 200; Body = $body; Error = '' }
    } catch {
        return @{ Status = (Get-HttpStatusCode $_); Body = $null; Error = $_.Exception.Message }
    }
}

# ---------------------------------------------------------------------------
# Programme principal
# ---------------------------------------------------------------------------

function Invoke-Push($State, $Config, $Payload) {
    $json = ConvertTo-PayloadJson $Payload
    $r = Invoke-Site -SiteUrl $Config.SiteUrl -Password $Config.Password -Method 'Put' -Query 'r=live-draft' -Json $json
    $now = Get-Date
    if ($r.Ok) {
        $State.LastPushError = ''
        $State.NextPushAfter = [datetime]::MinValue
        $State.LastKey = Get-PayloadKey $Payload
        $State.SentActive = ($Payload.phase -ne 'none')
        if ($Payload.phase -eq 'none') {
            Write-Info 'Envoyé au site : fin de la sélection des champions.' 'Green'
        } else {
            Write-Info ("Envoyé au site : {0}." -f (Get-PayloadSummary $Payload)) 'Green'
        }
        return $true
    }
    $msg = ''
    $delay = 5
    if ($r.Status -eq 401) {
        $msg = "Le site refuse le mot de passe. Relancez avec -Reset (Lancer-LoLHelper-Draft.bat -Reset)."
        $delay = 30
    } elseif ($r.Status -eq 404 -and $r.Detail -eq 'Route inconnue.') {
        $msg = "Le site ne connaît pas la draft en direct : il faut mettre le site à jour."
        $delay = 60
    } elseif ($r.Status -eq 404) {
        $msg = "Refusé par le site : $($r.Detail) Ajoutez $($State.Account) (avec son identifiant Riot) sur la page Équipe du site."
        $delay = 30
    } elseif ($r.Status -gt 0) {
        $msg = "Envoi refusé par le site (HTTP $($r.Status)) : $($r.Detail)"
        $delay = 10
    } else {
        $msg = "Site injoignable : $($r.Error) (nouvel essai dans quelques secondes)"
    }
    if ($msg -ne $State.LastPushError) { Write-Info $msg 'Yellow' }
    $State.LastPushError = $msg
    $State.NextPushAfter = $now.AddSeconds($delay)
    return $false
}

function Set-Status($State, [string]$Key, [string]$Message, [string]$Color = 'Gray') {
    if ($State.StatusKey -ne $Key) {
        $State.StatusKey = $Key
        Write-Info $Message $Color
    }
}

function Start-Companion {
    try { $Host.UI.RawUI.WindowTitle = 'LoLHelper - Draft en direct' } catch { }
    Write-Host ''
    Write-Host "LoLHelper - Draft en direct (compagnon v$script:CompanionVersion)" -ForegroundColor Cyan
    Write-Host 'Lecture seule du client League of Legends : aucune action automatique.'
    Write-Host ''

    if ($ConfigPath -eq '') { $ConfigPath = Get-DefaultConfigPath }
    if ($Reset -and (Test-Path -LiteralPath $ConfigPath)) {
        Remove-Item -LiteralPath $ConfigPath -Force
        Write-Host 'Configuration effacée.' -ForegroundColor Yellow
    }

    Initialize-Tls

    $config = Read-CompanionConfig $ConfigPath
    if ($null -eq $config) { $config = Invoke-ConfigWizard $ConfigPath }

    $lockfiles = @()
    if ($LockfilePath -ne '') { $lockfiles = @($LockfilePath) }
    else {
        if ($config.LockfilePath -ne '') { $lockfiles += $config.LockfilePath }
        $lockfiles += $script:DefaultLockfile
    }

    $meta = Test-SiteMeta $config.SiteUrl
    if ($meta.Ok) {
        Write-Info "Site joignable : $($config.SiteUrl)" 'Green'
    } else {
        Write-Info "Site injoignable pour le moment ($($meta.Error)) - nouvel essai à chaque envoi." 'Yellow'
    }
    Write-Info 'Ctrl+C pour quitter.'

    $state = @{
        Connection    = $null
        Puuid         = ''
        Account       = ''
        QueueId       = 0
        QueueGameKey  = $null
        LocalCell     = 0
        LastKey       = ''
        SentActive    = $false
        LastPushError = ''
        NextPushAfter = [datetime]::MinValue
        StatusKey     = ''
    }
    $started = Get-Date

    try {
        while ($true) {
            if ($MaxRunSeconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $MaxRunSeconds) { break }
            $sleep = 5
            $payload = $null
            $inChampSelect = $false

            # 1. Connexion au client (découverte à chaque fois qu'elle est perdue).
            if ($null -eq $state.Connection) {
                $script:ElevatedClientHint = $false
                foreach ($cand in (Get-LcuCandidates $lockfiles)) {
                    $conn = New-LcuConnection $cand
                    $probe = Invoke-Lcu $conn '/lol-summoner/v1/current-summoner'
                    if ($probe.Status -ne 0 -and $probe.Status -ne 401 -and $probe.Status -ne 403) {
                        $state.Connection = $conn
                        $state.StatusKey = ''
                        Write-Info "Client League trouvé ($($conn.Source), port $($conn.Port))." 'Green'
                        break
                    }
                }
                if ($null -eq $state.Connection) {
                    if ($script:ElevatedClientHint) {
                        Set-Status $state 'elevated' "Client League détecté mais illisible (lancé en administrateur ?). Indiquez son lockfile avec -LockfilePath." 'Yellow'
                    } else {
                        Set-Status $state 'waiting' 'En attente du client League of Legends (lancez-le, nouvelle tentative toutes les 5 s)...'
                    }
                }
            }

            $lcuLost = $false
            if ($null -ne $state.Connection) {
                # 2. Compte connecté (le puuid identifie le joueur sur le site).
                $sum = Invoke-Lcu $state.Connection '/lol-summoner/v1/current-summoner'
                if ($sum.Status -eq 0) {
                    $lcuLost = $true
                } elseif ($sum.Status -eq 200 -and $null -ne $sum.Body -and (Get-SafePuuid $sum.Body.puuid) -ne '') {
                    $puuid = Get-SafePuuid $sum.Body.puuid
                    if ($puuid -ne $state.Puuid) {
                        if ($state.SentActive -and $state.Puuid -ne '') {
                            [void](Invoke-Push $state $config (New-NonePayload $state.Puuid $state.QueueId $state.LocalCell))
                        }
                        $state.Puuid = $puuid
                        $state.LastKey = ''
                        $state.SentActive = $false
                        $name = [string]$sum.Body.gameName
                        if ($name -ne '' -and [string]$sum.Body.tagLine -ne '') { $name = "$name#$($sum.Body.tagLine)" }
                        elseif ($name -eq '') { $name = [string]$sum.Body.displayName }
                        $state.Account = $name
                        $state.StatusKey = ''
                        Write-Info "Connecté au client League : compte $name" 'Green'
                    }
                    # 3. Phase de jeu.
                    $gf = Invoke-Lcu $state.Connection '/lol-gameflow/v1/gameflow-phase'
                    if ($gf.Status -eq 0) {
                        $lcuLost = $true
                    } elseif ($gf.Status -eq 200 -and ([string]$gf.Body).Trim('"') -eq 'ChampSelect') {
                        $inChampSelect = $true
                        $sleep = 1
                        # 4. Sélection des champions.
                        $sess = Invoke-Lcu $state.Connection '/lol-champ-select/v1/session'
                        if ($sess.Status -eq 0) {
                            $lcuLost = $true
                        } elseif ($sess.Status -eq 200 -and $null -ne $sess.Body) {
                            $gameKey = [string]$sess.Body.gameId
                            if ($state.QueueGameKey -ne $gameKey) {
                                $state.QueueGameKey = $gameKey
                                $q = Get-IntOrDefault $sess.Body.queueId -1
                                if ($q -lt 0) {
                                    $q = 0
                                    $gs = Invoke-Lcu $state.Connection '/lol-gameflow/v1/session'
                                    if ($gs.Status -eq 200 -and $null -ne $gs.Body -and $null -ne $gs.Body.gameData) {
                                        $q = Get-IntOrDefault $gs.Body.gameData.queue.id 0
                                    }
                                }
                                $state.QueueId = $q
                                Write-Info "Sélection des champions détectée (file $q)." 'Cyan'
                            }
                            $payload = ConvertTo-CompanionPayload -Session $sess.Body -Puuid $state.Puuid -QueueId $state.QueueId
                            if ($null -ne $payload) { $state.LocalCell = $payload.local_cell }
                        }
                        # 404 : la sélection vient de se terminer (ou d'être annulée).
                    }
                    if (-not $lcuLost -and -not $inChampSelect) {
                        $phaseName = 'inconnue'
                        if ($gf.Status -eq 200) { $phaseName = ([string]$gf.Body).Trim('"') }
                        Set-Status $state "idle-$phaseName" "Compte $($state.Account) - en attente d'une sélection des champions (phase du client : $phaseName)."
                    }
                } else {
                    Set-Status $state 'starting' 'Client League en cours de démarrage...'
                }
            }

            if ($lcuLost) {
                $state.Connection = $null
                $state.QueueGameKey = $null
                Write-Info 'Connexion au client League perdue (fermé ou redémarré). Nouvelle recherche...' 'Yellow'
                $state.StatusKey = ''
                $sleep = 2
            }

            # 5. Envoi au site, seulement si quelque chose a changé.
            if ((Get-Date) -ge $state.NextPushAfter) {
                if ($null -ne $payload) {
                    if ((Get-PayloadKey $payload) -ne $state.LastKey) {
                        [void](Invoke-Push $state $config $payload)
                    }
                } elseif ($state.SentActive -and ($lcuLost -or -not $inChampSelect)) {
                    # Sélection terminée, annulée, ou client fermé : un seul envoi "none".
                    if (Invoke-Push $state $config (New-NonePayload $state.Puuid $state.QueueId $state.LocalCell)) {
                        $state.QueueGameKey = $null
                    }
                }
            }

            Start-Sleep -Seconds $sleep
        }
    } finally {
        if ($state.SentActive -and $state.Puuid -ne '') {
            Write-Info 'Arrêt : envoi de la fin de sélection au site...'
            [void](Invoke-Push $state $config (New-NonePayload $state.Puuid $state.QueueId $state.LocalCell))
        }
        Write-Info 'Programme arrêté.'
    }
}

if (-not $NoMain) {
    try {
        Start-Companion
    } catch {
        Write-Host ''
        Write-Host "Erreur : $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}
