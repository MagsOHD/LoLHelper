# Tests unitaires du compagnon (sans dépendance : ni Pester ni réseau).
# Windows PowerShell 5.1 : powershell -NoProfile -ExecutionPolicy Bypass -File companion\tests\unit.ps1
# PowerShell 7         : pwsh -NoProfile -File companion/tests/unit.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fixtures = Join-Path $here 'fixtures'
. (Join-Path (Split-Path -Parent $here) 'lolhelper-draft.ps1') -NoMain

$script:failures = 0
$script:passed = 0
function Check([string]$Name, [bool]$Condition, [string]$Info = '') {
    if ($Condition) { $script:passed++ } else { $script:failures++; Write-Host "ECHEC : $Name $Info" -ForegroundColor Red }
}
function Load([string]$Name) { ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $fixtures $Name))) }
function Canon($Obj) { ConvertTo-Json -InputObject $Obj -Depth 8 -Compress }

$local = (Load 'current-summoner.json').puuid
$at = '2026-11-10T20:00:00Z'

# --- Contrat CompanionPayload sur une session réelle (ban_pick) ---
$p = ConvertTo-CompanionPayload -Session (Load 'session-banpick.json') -Puuid $local -QueueId 420 -SentAt $at
$expected = Canon (Load 'expected-banpick.json')
$actual = ConvertTo-PayloadJson $p
Check 'ban_pick = expected-banpick.json' ($actual -eq (Canon (ConvertFrom-Json $actual)) -and (Canon (ConvertFrom-Json $actual)) -eq $expected) "`n attendu : $expected`n obtenu  : $actual"

# --- Aucune donnée d'identité adverse ---
foreach ($f in @('session-planning.json', 'session-banpick.json', 'session-finalization.json', 'session-game-starting.json')) {
    $json = ConvertTo-PayloadJson (ConvertTo-CompanionPayload -Session (Load $f) -Puuid $local -QueueId 420)
    Check "pas d'identité adverse ($f)" ($json -notmatch 'SECRET' -and $json -notmatch 'obf-enemy' -and $json -notmatch '99000') $json
    Check "pas de pseudo allié ($f)" ($json -notmatch '"Moi"' -and $json -notmatch 'gameName') $json
    $o = ConvertFrom-Json $json
    foreach ($e in @($o.their_team)) {
        $names = @($e.PSObject.Properties | ForEach-Object { $_.Name }) -join ','
        Check "their_team = cell,puuid,champion_key ($f)" ($names -eq 'cell,puuid,champion_key') $names
        Check "classée : puuid adverse vide ($f)" ($e.puuid -eq '') $e.puuid
    }
}

# --- Adversaires révélés par le client (Clash / tournoi / personnalisée) ---
$rs = Load 'session-revealed-banpick.json'
$rj = ConvertTo-PayloadJson (ConvertTo-CompanionPayload -Session $rs -Puuid $local -QueueId 700)
$r = ConvertFrom-Json $rj
Check 'révélés : 5 adversaires' (@($r.their_team).Count -eq 5)
for ($i = 0; $i -lt 5; $i++) {
    Check "révélés : puuid du client ($i)" ($r.their_team[$i].puuid -eq $rs.theirTeam[$i].puuid -and $r.their_team[$i].cell -eq $rs.theirTeam[$i].cellId) $rj
}
Check 'révélés : ni pseudo ni summonerId' ($rj -notmatch 'VisibleEnemy' -and $rj -notmatch 'CLASH' -and $rj -notmatch '88000' -and $rj -notmatch 'gameName') $rj
Check 'révélés : le reste inchangé' ((ConvertTo-PayloadJson $r.my_team) -eq (ConvertTo-PayloadJson (ConvertFrom-Json (ConvertTo-PayloadJson $p)).my_team))

# puuid adverse : uniquement le champ puuid du client, non vide et au format Riot ; jamais un autre champ.
$okPuuid = 'revealedEnemyX-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
$enemyCases = @(
    @{ Name = 'puuid valide'; Json = '{"cellId":5,"puuid":"' + $okPuuid + '"}'; Want = $okPuuid }
    @{ Name = 'puuid vide (classée)'; Json = '{"cellId":5,"puuid":"","obfuscatedPuuid":"' + $okPuuid + '","summonerId":990005,"gameName":"' + $okPuuid + '"}'; Want = '' }
    @{ Name = 'puuid absent'; Json = '{"cellId":5,"obfuscatedPuuid":"' + $okPuuid + '"}'; Want = '' }
    @{ Name = 'puuid null'; Json = '{"cellId":5,"puuid":null}'; Want = '' }
    @{ Name = 'puuid nombre'; Json = '{"cellId":5,"puuid":12345678901234567890123456789012345678901234567890}'; Want = '' }
    @{ Name = 'puuid masqué non conforme'; Json = '{"cellId":5,"puuid":"SECRET-ENEMY-PUUID-5"}'; Want = '' }
    @{ Name = 'puuid avec espaces'; Json = '{"cellId":5,"puuid":" ' + $okPuuid + ' "}'; Want = '' }
)
foreach ($c in $enemyCases) {
    $sess = ConvertFrom-Json ('{"localPlayerCellId":0,"timer":{"phase":"BAN_PICK"},"myTeam":[],"theirTeam":[' + $c.Json + ']}')
    $got = (ConvertTo-CompanionPayload -Session $sess -Puuid $local).their_team[0].puuid
    Check "their_team : $($c.Name)" ($got -eq $c.Want) "-> '$got'"
}

# --- Phases ---
$pl = ConvertTo-CompanionPayload -Session (Load 'session-planning.json') -Puuid $local -QueueId 420 -SentAt $at
Check 'planning' ($pl.phase -eq 'planning')
Check 'planning intent' ($pl.my_team[2].intent_key -eq 103 -and $pl.my_team[2].champion_key -eq 0)
Check 'planning bans vides' ((ConvertTo-PayloadJson $pl.bans) -eq '{"mine":[],"theirs":[]}') (ConvertTo-PayloadJson $pl.bans)
Check 'planning actions ban non faites' (@($pl.actions).Count -eq 10 -and -not $pl.actions[0].completed)
Check 'finalization' ((ConvertTo-CompanionPayload -Session (Load 'session-finalization.json') -Puuid $local).phase -eq 'finalization')
$gs = ConvertTo-CompanionPayload -Session (Load 'session-game-starting.json') -Puuid $local
Check 'game_starting' ($gs.phase -eq 'game_starting' -and $gs.timer_remaining_ms -eq 0)
Check 'finalization 10 champions' ((@($gs.my_team | Where-Object { $_.champion_key -gt 0 }).Count -eq 5) -and (@($gs.their_team | Where-Object { $_.champion_key -gt 0 }).Count -eq 5))

$s = Load 'session-banpick.json'; $s.isSpectating = $true
Check 'spectateur ignoré' ($null -eq (ConvertTo-CompanionPayload -Session $s -Puuid $local))
$s = Load 'session-banpick.json'; $s.timer.phase = 'WEIRD'
Check 'phase inconnue ignorée' ($null -eq (ConvertTo-CompanionPayload -Session $s -Puuid $local))
$s = Load 'session-banpick.json'; $s.timer.phase = 'ban_pick'
Check 'phase insensible à la casse' ((ConvertTo-CompanionPayload -Session $s -Puuid $local).phase -eq 'ban_pick')

# --- Secours bannissements depuis les actions ---
$s = Load 'session-banpick.json'; $s.bans.myTeamBans = @(); $s.bans.theirTeamBans = @()
$b = ConvertTo-CompanionPayload -Session $s -Puuid $local
Check 'bans depuis actions' ((ConvertTo-PayloadJson $b.bans) -eq '{"mine":[55,0,238,157,84],"theirs":[91,7,11,64,121]}') (ConvertTo-PayloadJson $b.bans)

# --- Bornes, positions, tableaux à un élément ---
$mini = ConvertFrom-Json '{"localPlayerCellId":0,"timer":{"phase":"BAN_PICK","adjustedTimeLeftInPhase":-5,"isInfinite":false},"myTeam":[{"cellId":0,"championId":5000,"championPickIntent":-1,"assignedPosition":"MIDDLE","puuid":"bad puuid!"}],"theirTeam":[{"cellId":5,"championId":266,"puuid":"x","gameName":"y"}],"actions":[[{"actorCellId":0,"championId":1,"completed":false,"isAllyAction":true,"isInProgress":true,"type":"pick"}]],"bans":{"myTeamBans":[1],"theirTeamBans":null}}'
$m = ConvertTo-CompanionPayload -Session $mini -Puuid $local -QueueId 0 -SentAt $at
$mj = ConvertTo-PayloadJson $m
Check 'tableau à 1 élément' ($mj -match '"my_team":\[\{' -and $mj -match '"their_team":\[\{' -and $mj -match '"actions":\[\{' -and $mj -match '"mine":\[1\]' -and $mj -match '"theirs":\[\]') $mj
Check 'bornes champion' ($m.my_team[0].champion_key -eq 0 -and $m.my_team[0].intent_key -eq 0 -and $m.their_team[0].champion_key -eq 266)
Check 'position minuscule' ($m.my_team[0].position -eq 'middle')
Check 'puuid invalide vidé' ($m.my_team[0].puuid -eq '' -and $m.their_team[0].puuid -eq '')
Check 'chrono >= 0' ($m.timer_remaining_ms -eq 0)
$mini.myTeam[0].assignedPosition = 'fill'
Check 'position inconnue vide' ((ConvertTo-CompanionPayload -Session $mini -Puuid $local).my_team[0].position -eq '')
$mini.timer.isInfinite = $true; $mini.timer.adjustedTimeLeftInPhase = 99999999
Check 'chrono infini = 0' ((ConvertTo-CompanionPayload -Session $mini -Puuid $local).timer_remaining_ms -eq 0)

$big = Load 'session-banpick.json'
$turns = @(); for ($i = 0; $i -lt 40; $i++) { $turns += , @([pscustomobject]@{ actorCellId = 1; championId = 1; completed = $true; isAllyAction = $true; isInProgress = $false; type = 'pick' }) }
$big.actions = $turns
$big.myTeam = @($big.myTeam) + @($big.myTeam)
$bp = ConvertTo-CompanionPayload -Session $big -Puuid $local
Check 'actions <= 30' (@($bp.actions).Count -eq 30) (@($bp.actions).Count)
Check 'my_team <= 5' (@($bp.my_team).Count -eq 5)

# --- Empreinte : ni sent_at ni chrono ---
$k1 = Get-PayloadKey (ConvertTo-CompanionPayload -Session (Load 'session-banpick.json') -Puuid $local -SentAt '2026-01-01T00:00:00Z')
$s = Load 'session-banpick.json'; $s.timer.adjustedTimeLeftInPhase = 3000
$k2 = Get-PayloadKey (ConvertTo-CompanionPayload -Session $s -Puuid $local -SentAt '2026-01-01T00:00:09Z')
Check 'empreinte stable' ($k1 -eq $k2)
$s.myTeam[1].championPickIntent = 64
Check 'empreinte change' ($k1 -ne (Get-PayloadKey (ConvertTo-CompanionPayload -Session $s -Puuid $local)))

# --- Payload "none" ---
$n = ConvertTo-PayloadJson (New-NonePayload $local 420 2 $at)
Check 'none' ($n -eq ('{"version":1,"puuid":"' + $local + '","phase":"none","queue_id":420,"local_cell":2,"my_team":[],"their_team":[],"bans":{"mine":[],"theirs":[]},"actions":[],"timer_remaining_ms":0,"sent_at":"' + $at + '"}')) $n

# --- Lockfile / ligne de commande ---
$c = ConvertFrom-Lockfile 'LeagueClient:12345:54321:AbC-dEf_123:https'
Check 'lockfile' ($c.Port -eq 54321 -and $c.Token -eq 'AbC-dEf_123')
Check 'lockfile invalide' ($null -eq (ConvertFrom-Lockfile 'garbage') -and $null -eq (ConvertFrom-Lockfile '') -and $null -eq (ConvertFrom-Lockfile 'a:b:99999:t:https'))
$c = ConvertFrom-LeagueCommandLine '"C:/Riot Games/League of Legends/LeagueClientUx.exe" "--riotclient-auth-token=zzz" "--riotclient-app-port=1111" "--remoting-auth-token=Tok_en-9" "--app-port=50123" "--install-directory=C:\Riot Games\League of Legends"'
Check 'cmdline guillemets' ($c.Port -eq 50123 -and $c.Token -eq 'Tok_en-9') "$($c.Port) $($c.Token)"
$c = ConvertFrom-LeagueCommandLine 'LeagueClientUx.exe --app-port=2999 --remoting-auth-token=abc'
Check 'cmdline simple' ($c.Port -eq 2999 -and $c.Token -eq 'abc')
Check 'cmdline vide' ($null -eq (ConvertFrom-LeagueCommandLine '') -and $null -eq (ConvertFrom-LeagueCommandLine 'LeagueClientUx.exe --app-port=1'))

# --- Adresse du site ---
$cases = @{
    'https://mon-domaine.fr/lolhelper'                 = 'https://mon-domaine.fr/lolhelper'
    ' mon-domaine.fr/lolhelper/ '                      = 'https://mon-domaine.fr/lolhelper'
    'https://mon-domaine.fr/lolhelper/#/team/abc'      = 'https://mon-domaine.fr/lolhelper'
    'https://mon-domaine.fr/lolhelper/index.html'      = 'https://mon-domaine.fr/lolhelper'
    'https://mon-domaine.fr/api/index.php?r=meta'      = 'https://mon-domaine.fr'
    'http://127.0.0.1:8080'                            = 'http://127.0.0.1:8080'
}
foreach ($k in $cases.Keys) {
    $got = Get-NormalizedSiteUrl $k
    Check "url '$k'" ($got -eq $cases[$k]) "-> $got"
}
Check 'url invalide' ($null -eq (Get-NormalizedSiteUrl '') -and $null -eq (Get-NormalizedSiteUrl 'ftp://x.fr') -and $null -eq (Get-NormalizedSiteUrl 'https://'))

# --- Configuration (DPAPI sous Windows) ---
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("lolhelper-test-" + [guid]::NewGuid().ToString('N'))
$cfgPath = Join-Path (Join-Path $tmp 'LoLHelper') 'config.json'
Save-CompanionConfig -Path $cfgPath -SiteUrl 'https://x.fr/lol' -Password 'mot de passe é'
$rawCfg = [IO.File]::ReadAllText($cfgPath)
Check 'config sans mot de passe en clair' ($rawCfg -notmatch 'mot de passe')
$cfg = Read-CompanionConfig $cfgPath
Check 'config relue' ($cfg.SiteUrl -eq 'https://x.fr/lol' -and $cfg.Password -eq 'mot de passe é')
Remove-Item -Recurse -Force $tmp

# --- Rappel de certificat (compilé comme sous PowerShell 5.1) ---
if (-not ('LoLHelperCompanion.LcuCertificatePolicy' -as [type])) { Add-Type -TypeDefinition $script:LcuCertPolicySource -Language CSharp }
Check 'IsLcuUri 127.0.0.1' ([LoLHelperCompanion.LcuCertificatePolicy]::IsLcuUri([Uri]'https://127.0.0.1:54321/lol-summoner/v1/current-summoner'))
Check 'IsLcuUri refuse le reste' (-not [LoLHelperCompanion.LcuCertificatePolicy]::IsLcuUri([Uri]'https://mon-domaine.fr/') -and -not [LoLHelperCompanion.LcuCertificatePolicy]::IsLcuUri([Uri]'https://localhost:54321/') -and -not [LoLHelperCompanion.LcuCertificatePolicy]::IsLcuUri([Uri]'http://127.0.0.1:54321/') -and -not [LoLHelperCompanion.LcuCertificatePolicy]::IsLcuUri([Uri]'https://127.0.0.1.evil.fr/'))
Check 'Validate refuse sans requête' (-not [LoLHelperCompanion.LcuCertificatePolicy]::Validate($null, $null, $null, [Net.Security.SslPolicyErrors]::RemoteCertificateChainErrors))

Write-Host ("Tests unitaires : {0} réussis, {1} échec(s)." -f $script:passed, $script:failures)
if ($script:failures -gt 0) { exit 1 }
