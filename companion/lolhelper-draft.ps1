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

.PARAMETER Diagnostic
    Écrit %TEMP%\lolhelper-diagnostic.json : réponses brutes du client League (compte connecté,
    phase, sélection des champions), identifiants et pseudos des AUTRES joueurs masqués. Le programme
    continue de fonctionner normalement.

.PARAMETER MaxRunSeconds
    (Tests) Arrête le programme après ce nombre de secondes. 0 = jamais.

.PARAMETER NoMain
    (Tests) Charge uniquement les fonctions, sans lancer le programme.

.PARAMETER NoRiotIdWarnSeconds
    (Tests) Délai avant le message « identifiant Riot absent » (30 s par défaut).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1 -Reset
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\lolhelper-draft.ps1 -Diagnostic
#>
[CmdletBinding()]
param(
    [switch]$Reset,
    [string]$ConfigPath = '',
    [string]$LockfilePath = '',
    [int]$MaxRunSeconds = 0,
    [switch]$NoMain,
    [switch]$Diagnostic,
    [int]$NoRiotIdWarnSeconds = 30
)

$ErrorActionPreference = 'Stop'

$script:CompanionVersion = '1.2.0'
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
# puuid tel que le client League le fournit (UUID « xxxxxxxx-xxxx-… » ou autre) : ce n'est PAS le puuid
# chiffré de l'API Riot. Même règle que l'API du site (LIVE_LCU_PUUID_PATTERN).
$script:PuuidPattern = '^[A-Za-z0-9_-]{8,100}\z'
$script:RiotIdMaxGameName = 32
$script:RiotIdMaxTagLine = 8
$script:Masked = '<masqué>'
# Champs d'identité masqués dans le fichier de diagnostic (sauf pour le joueur local).
$script:IdentityFields = @('puuid', 'summonerId', 'obfuscatedPuuid', 'obfuscatedSummonerId', 'accountId',
    'gameName', 'tagLine', 'summonerName', 'displayName', 'internalName', 'summonerInternalName', 'playerAlias', 'name')
# Secrets de discussion du client : toujours masqués.
$script:SecretFields = @('jwt', 'multiUserChatPassword', 'multiUserChatId', 'multiUserChatJWT', 'channelClaim')

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

<#
  Identifiant Riot {game_name, tag_line} si les deux parties sont des textes utilisables (non vides,
  longueur raisonnable, sans caractère de contrôle ni « # »), sinon $null.
#>
function Get-SafeRiotId($GameName, $TagLine) {
    if (-not ($GameName -is [string]) -or -not ($TagLine -is [string])) { return $null }
    $gn = $GameName.Trim()
    $tl = $TagLine.Trim().TrimStart('#').Trim()
    if ($gn -eq '' -or $tl -eq '') { return $null }
    if ($gn.Length -gt $script:RiotIdMaxGameName -or $tl.Length -gt $script:RiotIdMaxTagLine) { return $null }
    foreach ($part in @($gn, $tl)) {
        if ($part.Contains('#')) { return $null }
        foreach ($ch in $part.ToCharArray()) {
            $cat = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
            if ($cat -eq [Globalization.UnicodeCategory]::Control -or $cat -eq [Globalization.UnicodeCategory]::Format -or
                $cat -eq [Globalization.UnicodeCategory]::LineSeparator -or $cat -eq [Globalization.UnicodeCategory]::ParagraphSeparator) { return $null }
        }
    }
    return [ordered]@{ game_name = $gn; tag_line = $tl }
}

function Format-RiotId($RiotId) {
    if ($null -eq $RiotId) { return '' }
    return ('{0}#{1}' -f $RiotId.game_name, $RiotId.tag_line)
}

<#
  Identifiant Riot d'un joueur de la sélection (myTeam / theirTeam), UNIQUEMENT si le client League
  l'affiche lui-même : gameName et tagLine non vides et, quand le champ nameVisibilityType existe, valeur
  "VISIBLE". Toute autre valeur (HIDDEN, UNHIDDEN_BY_OTHER..., vide) = masqué -> $null. En classée
  solo/duo, les joueurs hors de votre groupe restent ainsi anonymes.
#>
function Get-VisibleRiotId($Entry) {
    if ($null -eq $Entry) { return $null }
    $props = @($Entry.PSObject.Properties | ForEach-Object { $_.Name })
    if ($props -contains 'nameVisibilityType' -and $null -ne $Entry.nameVisibilityType) {
        $vis = $Entry.nameVisibilityType
        if (-not ($vis -is [string]) -or $vis.ToUpperInvariant() -ne 'VISIBLE') { return $null }
    }
    return (Get-SafeRiotId $Entry.gameName $Entry.tagLine)
}

<#
  puuid d'un adversaire tel que le client League le fournit (champ "puuid" de l'entrée theirTeam), ou "".
  Le client ne le remplit que lorsque l'équipe adverse est visible (Clash, tournoi, partie personnalisée) ;
  en classée/normale il est vide. Jamais déduit d'un autre champ ou d'un autre endpoint.
#>
function Get-RevealedEnemyPuuid($Entry) {
    if ($null -eq $Entry) { return '' }
    $v = $Entry.puuid
    if (-not ($v -is [string]) -or $v -eq '') { return '' }
    return (Get-SafePuuid $v)
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
  Session de sélection des champions (LCU /lol-champ-select/v1/session) -> CompanionPayload v2.
  Le site reconnaît les joueurs par leur identifiant Riot (nom#tag) : celui du compte connecté ($RiotId),
  et celui d'un coéquipier ou d'un adversaire SEULEMENT quand le client League l'affiche (groupe, Clash,
  tournoi, partie personnalisée ; jamais les joueurs masqués de la classée solo/duo). Les puuid sont ceux
  du client, tels quels (ou "") ; aucune autre donnée (summonerId, obfuscatedPuuid...) n'est utilisée.
  Retourne $null si la session n'est pas exploitable (spectateur, phase inconnue).
#>
function ConvertTo-CompanionPayload {
    param(
        [Parameter(Mandatory = $true)] $Session,
        [Parameter(Mandatory = $true)] [AllowEmptyString()] [string]$Puuid,
        $RiotId = $null,
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
        $slot = [ordered]@{
            cell  = Get-IntOrDefault $m.cellId 0
            puuid = Get-SafePuuid $m.puuid
        }
        $rid = Get-VisibleRiotId $m
        if ($null -ne $rid) { $slot.riot_id = $rid }
        $slot.champion_key = Get-ChampionKey $m.championId
        $slot.intent_key = Get-ChampionKey $m.championPickIntent
        $slot.position = $pos
        $myTeam.Add($slot)
    }

    $theirTeam = New-Object 'System.Collections.Generic.List[object]'
    foreach ($m in @($Session.theirTeam)) {
        if ($null -eq $m) { continue }
        if ($theirTeam.Count -ge 5) { break }
        # Volontairement : ni summonerId ni identifiant masqué ; le nom seulement si le client l'affiche.
        $slot = [ordered]@{
            cell  = Get-IntOrDefault $m.cellId 0
            puuid = Get-RevealedEnemyPuuid $m
        }
        $rid = Get-VisibleRiotId $m
        if ($null -ne $rid) { $slot.riot_id = $rid }
        $slot.champion_key = Get-ChampionKey $m.championId
        $theirTeam.Add($slot)
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
        version            = 2
        puuid              = $Puuid
        riot_id            = $RiotId
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
function New-NonePayload([string]$Puuid, $RiotId = $null, [int]$QueueId = 0, [int]$LocalCell = 0, [string]$SentAt = '') {
    if ([string]::IsNullOrEmpty($SentAt)) { $SentAt = Get-UtcTimestamp }
    return [ordered]@{
        version            = 2
        puuid              = $Puuid
        riot_id            = $RiotId
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
    # En-tête en « b64:<UTF-8> » : les accents passent (le site décode, et accepte aussi la forme brute).
    if ($Password -ne '') { $headers['X-App-Password'] = 'b64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Password.Trim())) }
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

<#
  GET sur l'API locale du client. Status 0 = client injoignable.
  Corps toujours décodé en UTF-8 (Windows PowerShell 5.1 se tromperait d'encodage sans « charset » :
  pseudos accentués).
#>
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
        $resp = Invoke-WebRequest @params
        $text = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        $body = $null
        if (-not [string]::IsNullOrWhiteSpace($text)) { $body = ConvertFrom-Json $text }
        return @{ Status = [int]$resp.StatusCode; Body = $body; Error = '' }
    } catch {
        return @{ Status = (Get-HttpStatusCode $_); Body = $null; Error = $_.Exception.Message }
    }
}

# ---------------------------------------------------------------------------
# Diagnostic (-Diagnostic) : réponses du client, identités des autres joueurs masquées
# ---------------------------------------------------------------------------

function Test-IdentityValue($Value) {
    if ($null -eq $Value) { return $false }
    if ($Value -is [string]) { return $Value -ne '' }
    if ($Value -is [bool]) { return $false }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) { return $Value -ne 0 }
    return $true
}

<# L'objet décrit-il le joueur local (même puuid, même summonerId, même nom#tag ou sa cellule) ? #>
function Test-LocalIdentity($Obj, $Local) {
    if ($null -eq $Local) { return $false }
    $names = @($Obj.PSObject.Properties | ForEach-Object { $_.Name })
    if ($Local.Puuid -ne '' -and $names -contains 'puuid' -and [string]$Obj.puuid -eq $Local.Puuid) { return $true }
    if ($Local.SummonerId -ne '' -and $Local.SummonerId -ne '0' -and $names -contains 'summonerId' -and [string]$Obj.summonerId -eq $Local.SummonerId) { return $true }
    if ($Local.GameName -ne '' -and $Local.TagLine -ne '' -and $names -contains 'gameName' -and $names -contains 'tagLine' -and
        ([string]$Obj.gameName).Trim() -ieq $Local.GameName -and ([string]$Obj.tagLine).Trim() -ieq $Local.TagLine) { return $true }
    if ($null -ne $Local.Cell -and $names -contains 'cellId' -and $null -ne $Obj.cellId -and [string]$Obj.cellId -eq [string]$Local.Cell) { return $true }
    return $false
}

<#
  Copie d'une réponse du client où chaque identifiant (puuid, summonerId, obfuscatedPuuid, accountId...)
  et chaque pseudo (gameName, tagLine...) d'un AUTRE joueur devient "<masqué>" (valeurs vides laissées
  telles quelles : savoir qu'un champ est vide aide au diagnostic). Les secrets de discussion sont
  toujours masqués. -IsLocal : l'objet racine est le joueur local (current-summoner).
#>
function ConvertTo-RedactedLcu($Value, $Local = $null, [switch]$IsLocal) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return $Value }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $mine = $IsLocal -or (Test-LocalIdentity $Value $Local)
        $out = [ordered]@{}
        foreach ($prop in $Value.PSObject.Properties) {
            $n = $prop.Name
            $v = $prop.Value
            if ($script:SecretFields -contains $n) {
                if (Test-IdentityValue $v) { $out[$n] = $script:Masked } else { $out[$n] = $v }
            } elseif ($script:IdentityFields -contains $n -and -not $mine) {
                if (Test-IdentityValue $v) { $out[$n] = $script:Masked } else { $out[$n] = $v }
            } else {
                $out[$n] = ConvertTo-RedactedLcu $v $Local
            }
        }
        return $out
    }
    if ($Value -is [Collections.IList]) {
        $list = New-Object 'System.Collections.Generic.List[object]'
        foreach ($item in $Value) { $list.Add((ConvertTo-RedactedLcu $item $Local)) }
        return , $list.ToArray()
    }
    return $Value
}

function Get-LocalIdentity($Summoner, $Session = $null) {
    $local = @{ Puuid = ''; SummonerId = ''; GameName = ''; TagLine = ''; Cell = $null }
    if ($null -ne $Summoner) {
        if ($null -ne $Summoner.puuid) { $local.Puuid = [string]$Summoner.puuid }
        if ($null -ne $Summoner.summonerId) { $local.SummonerId = [string]$Summoner.summonerId }
        if ($Summoner.gameName -is [string]) { $local.GameName = $Summoner.gameName.Trim() }
        if ($Summoner.tagLine -is [string]) { $local.TagLine = $Summoner.tagLine.Trim() }
    }
    if ($null -ne $Session -and $null -ne $Session.localPlayerCellId) { $local.Cell = $Session.localPlayerCellId }
    return $local
}

function Get-DiagnosticPath {
    $dir = $env:TEMP
    if ([string]::IsNullOrEmpty($dir)) { $dir = [IO.Path]::GetTempPath() }
    return (Join-Path $dir 'lolhelper-diagnostic.json')
}

<# Contenu du fichier de diagnostic (fonction pure, testée). #>
function New-DiagnosticDocument($State, [string]$GeneratedAt = '') {
    if ([string]::IsNullOrEmpty($GeneratedAt)) { $GeneratedAt = Get-UtcTimestamp }
    $d = $State.Diag
    $summoner = $null
    if ($null -ne $d.Summoner) { $summoner = $d.Summoner.Body }
    $localNow = Get-LocalIdentity $summoner
    $doc = [ordered]@{
        generated_at      = $GeneratedAt
        companion_version = $script:CompanionVersion
        powershell        = [string]$PSVersionTable.PSVersion
        note              = 'Réponses brutes du client League (GET). Identifiants et pseudos des autres joueurs remplacés par "<masqué>".'
        lcu_connected     = ($null -ne $State.Connection)
        lcu_source        = ''
        current_summoner  = $null
        gameflow_phase    = $null
        champ_select_session = $null
        interpretation    = [ordered]@{
            local_puuid_accepted = ((Get-SafePuuid $localNow.Puuid) -ne '')
            local_riot_id        = (Format-RiotId (Get-SafeRiotId $localNow.GameName $localNow.TagLine))
            status               = $State.StatusKey
        }
    }
    if ($null -ne $State.Connection) { $doc.lcu_source = "$($State.Connection.Source), port $($State.Connection.Port)" }
    if ($null -ne $d.Summoner) {
        $doc.current_summoner = [ordered]@{ status = $d.Summoner.Status; at = $d.Summoner.At; body = (ConvertTo-RedactedLcu $d.Summoner.Body $null -IsLocal) }
    }
    if ($null -ne $d.Gameflow) {
        $doc.gameflow_phase = [ordered]@{ status = $d.Gameflow.Status; at = $d.Gameflow.At; body = (ConvertTo-RedactedLcu $d.Gameflow.Body $null) }
    }
    if ($null -ne $d.Session) {
        $sl = $d.Session.Summoner
        $local = Get-LocalIdentity $sl $d.Session.Body
        $doc.champ_select_session = [ordered]@{ status = $d.Session.Status; at = $d.Session.At; body = (ConvertTo-RedactedLcu $d.Session.Body $local) }
    }
    return $doc
}

function Save-Diagnostic($State, [switch]$Force) {
    if (-not $Diagnostic) { return }
    $now = Get-Date
    if (-not $Force -and ($now - $State.Diag.LastWrite).TotalSeconds -lt 3) { return }
    $State.Diag.LastWrite = $now
    $path = Get-DiagnosticPath
    try {
        $json = ConvertTo-Json -InputObject (New-DiagnosticDocument $State) -Depth 16
        [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding $false))
        if (-not $State.Diag.Announced) {
            $State.Diag.Announced = $true
            Write-Info "Diagnostic : fichier $path (mis à jour toutes les quelques secondes ; pseudos et identifiants des autres joueurs masqués)." 'Cyan'
        }
    } catch {
        if (-not $State.Diag.Failed) {
            $State.Diag.Failed = $true
            Write-Info "Diagnostic : impossible d'écrire $path ($($_.Exception.Message))." 'Yellow'
        }
    }
}

function Set-DiagnosticEntry($State, [string]$Name, $Response, $Summoner = $null) {
    if (-not $Diagnostic) { return }
    $State.Diag[$Name] = @{ Status = $Response.Status; Body = $Response.Body; At = (Get-UtcTimestamp); Summoner = $Summoner }
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
        RiotId        = $null
        Identity      = ''
        Account       = ''
        NoRiotIdSince = $null
        SummonerErrorSince = $null
        QueueId       = 0
        QueueGameKey  = $null
        LocalCell     = 0
        LastKey       = ''
        SentActive    = $false
        LastPushError = ''
        NextPushAfter = [datetime]::MinValue
        StatusKey     = ''
        Diag          = @{ Summoner = $null; Gameflow = $null; Session = $null; LastWrite = [datetime]::MinValue; Announced = $false; Failed = $false }
    }
    $started = Get-Date
    if ($Diagnostic) {
        Write-Info "Mode diagnostic activé : $(Get-DiagnosticPath)" 'Cyan'
        Save-Diagnostic $state -Force
    }

    try {
        while ($true) {
            if ($MaxRunSeconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $MaxRunSeconds) { break }
            $sleep = 5
            $payload = $null
            $inChampSelect = $false

            # 1. Connexion au client (découverte à chaque fois qu'elle est perdue).
            if ($null -eq $state.Connection) {
                $script:ElevatedClientHint = $false
                # Plusieurs candidats possibles (ancien lockfile, plusieurs installations) : on garde en priorité
                # celui qui renvoie le compte (200), sinon le premier qui répond.
                $fallback = $null
                foreach ($cand in (Get-LcuCandidates $lockfiles)) {
                    $conn = New-LcuConnection $cand
                    $probe = Invoke-Lcu $conn '/lol-summoner/v1/current-summoner'
                    if ($probe.Status -eq 200) { $state.Connection = $conn; break }
                    if ($null -eq $fallback -and $probe.Status -ne 0 -and $probe.Status -ne 401 -and $probe.Status -ne 403) { $fallback = $conn }
                }
                if ($null -eq $state.Connection -and $null -ne $fallback) { $state.Connection = $fallback }
                if ($null -ne $state.Connection) {
                    $state.StatusKey = ''
                    Write-Info "Client League trouvé ($($state.Connection.Source), port $($state.Connection.Port))." 'Green'
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
                # 2. Compte connecté : le site reconnaît le joueur par son identifiant Riot (nom#tag) ;
                #    le puuid du client (format UUID) n'est pas celui de l'API Riot et sert seulement d'appoint.
                $sum = Invoke-Lcu $state.Connection '/lol-summoner/v1/current-summoner'
                Set-DiagnosticEntry $state 'Summoner' $sum
                $riotId = $null
                if ($sum.Status -eq 200 -and $null -ne $sum.Body) { $riotId = Get-SafeRiotId $sum.Body.gameName $sum.Body.tagLine }
                if ($sum.Status -eq 0) {
                    $lcuLost = $true
                } elseif ($null -ne $riotId) {
                    $state.NoRiotIdSince = $null
                    $state.SummonerErrorSince = $null
                    $puuid = Get-SafePuuid $sum.Body.puuid
                    $identity = (Format-RiotId $riotId).ToLowerInvariant() + '|' + $puuid
                    if ($identity -ne $state.Identity) {
                        if ($state.SentActive -and $state.Identity -ne '') {
                            [void](Invoke-Push $state $config (New-NonePayload $state.Puuid $state.RiotId $state.QueueId $state.LocalCell))
                        }
                        $state.Identity = $identity
                        $state.Puuid = $puuid
                        $state.RiotId = $riotId
                        $state.LastKey = ''
                        $state.SentActive = $false
                        $state.Account = Format-RiotId $riotId
                        $state.StatusKey = ''
                        Write-Info "Connecté au client League : compte $($state.Account)" 'Green'
                    }
                    # 3. Phase de jeu.
                    $gf = Invoke-Lcu $state.Connection '/lol-gameflow/v1/gameflow-phase'
                    Set-DiagnosticEntry $state 'Gameflow' $gf
                    if ($gf.Status -eq 0) {
                        $lcuLost = $true
                    } elseif ($gf.Status -eq 200 -and ([string]$gf.Body).Trim('"') -eq 'ChampSelect') {
                        $inChampSelect = $true
                        $sleep = 1
                        # 4. Sélection des champions.
                        $sess = Invoke-Lcu $state.Connection '/lol-champ-select/v1/session'
                        if ($sess.Status -eq 200) { Set-DiagnosticEntry $state 'Session' $sess $sum.Body }
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
                            $payload = ConvertTo-CompanionPayload -Session $sess.Body -Puuid $state.Puuid -RiotId $state.RiotId -QueueId $state.QueueId
                            if ($null -ne $payload) { $state.LocalCell = $payload.local_cell }
                        }
                        # 404 : la sélection vient de se terminer (ou d'être annulée).
                    }
                    if (-not $lcuLost -and -not $inChampSelect) {
                        $phaseName = 'inconnue'
                        if ($gf.Status -eq 200) { $phaseName = ([string]$gf.Body).Trim('"') }
                        Set-Status $state "idle-$phaseName" "Compte $($state.Account) - en attente d'une sélection des champions (phase du client : $phaseName)."
                    }
                } elseif ($sum.Status -eq 200) {
                    # Le client répond mais sans nom#tag : normal quelques secondes au démarrage, anormal ensuite.
                    $sleep = 2
                    if ($null -eq $state.NoRiotIdSince) { $state.NoRiotIdSince = Get-Date }
                    if (((Get-Date) - $state.NoRiotIdSince).TotalSeconds -ge $NoRiotIdWarnSeconds) {
                        Set-Status $state 'no-riot-id' ("Le client League est lancé mais ne fournit pas votre identifiant Riot (nom#tag) : impossible de vous reconnaître sur le site. " +
                            "Redémarrez le client League. Si le message reste affiché, relancez le compagnon avec -Diagnostic " +
                            "(Lancer-LoLHelper-Draft.bat -Diagnostic) et transmettez le fichier indiqué.") 'Yellow'
                    } else {
                        Set-Status $state 'starting' 'Client League en cours de démarrage...'
                    }
                } else {
                    # Le client répond mais refuse la lecture du compte : normal quelques secondes au démarrage.
                    $sleep = 2
                    $state.NoRiotIdSince = $null
                    if ($null -eq $state.SummonerErrorSince) { $state.SummonerErrorSince = Get-Date }
                    if (((Get-Date) - $state.SummonerErrorSince).TotalSeconds -ge $NoRiotIdWarnSeconds) {
                        Set-Status $state "summoner-$($sum.Status)" ("Le client League répond ($($state.Connection.Source), port $($state.Connection.Port)) " +
                            "mais la lecture du compte échoue (code HTTP $($sum.Status)). Nouvelle recherche du client... " +
                            "Si le message revient, redémarrez le client League ou relancez avec -Diagnostic " +
                            "(Lancer-LoLHelper-Draft.bat -Diagnostic) et transmettez le fichier indiqué.") 'Yellow'
                        # Peut-être un mauvais candidat (ancien lockfile) : on relance la découverte.
                        $state.Connection = $null
                        $state.SummonerErrorSince = $null
                    } else {
                        Set-Status $state 'starting' 'Client League en cours de démarrage...'
                    }
                }
            }

            if ($lcuLost) {
                $state.Connection = $null
                $state.QueueGameKey = $null
                $state.NoRiotIdSince = $null
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
                    if (Invoke-Push $state $config (New-NonePayload $state.Puuid $state.RiotId $state.QueueId $state.LocalCell)) {
                        $state.QueueGameKey = $null
                    }
                }
            }

            Save-Diagnostic $state
            Start-Sleep -Seconds $sleep
        }
    } finally {
        if ($state.SentActive -and $state.Identity -ne '') {
            Write-Info 'Arrêt : envoi de la fin de sélection au site...'
            [void](Invoke-Push $state $config (New-NonePayload $state.Puuid $state.RiotId $state.QueueId $state.LocalCell))
        }
        if ($Diagnostic) { Save-Diagnostic $state -Force }
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
