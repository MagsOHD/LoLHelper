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

$summoner = Load 'current-summoner.json'
$local = $summoner.puuid
$rid = Get-SafeRiotId $summoner.gameName $summoner.tagLine
$at = '2026-11-10T20:00:00Z'

# --- puuid du client (UUID) et identifiant Riot ---
Check 'puuid UUID du client accepté' ((Get-SafePuuid $local) -eq $local -and $local -match '^[0-9a-f]{8}-[0-9a-f]{4}-')
$riotApiPuuid = 'kX9v2bQx3Lr7nT0pWq8sYz1aB4cD5eF6gH7iJ8kL9mN0oP1qR2sT3uV4wX5yZ6aB7cD8eF9gH0iJ1k'
Check 'puuid format API Riot accepté' ((Get-SafePuuid $riotApiPuuid) -eq $riotApiPuuid)
Check 'puuid refusés' ((Get-SafePuuid 'abc') -eq '' -and (Get-SafePuuid "$local`n") -eq '' -and (Get-SafePuuid "a/b-cdefgh") -eq '' -and
    (Get-SafePuuid ('a' * 101)) -eq '' -and (Get-SafePuuid $null) -eq '' -and (Get-SafePuuid ' ') -eq '')
Check 'riot_id local' ((Format-RiotId $rid) -eq 'Moi#EUW' -and (ConvertTo-PayloadJson $rid) -eq '{"game_name":"Moi","tag_line":"EUW"}') (ConvertTo-PayloadJson $rid)
Check 'riot_id nettoyé' ((Format-RiotId (Get-SafeRiotId '  Le Fou Élégant ' ' #EUW1 ')) -eq 'Le Fou Élégant#EUW1')
$badIds = @(
    @('', 'EUW'), @('Moi', ''), @('   ', 'EUW'), @($null, 'EUW'), @('Moi', $null), @(12, 'EUW'), @('Moi', 42),
    @(('a' * 33), 'EUW'), @('Moi', 'ABCDEFGHI'), @("Mo`ni", 'EUW'), @("Moi$([char]0x200B)", 'EUW'), @('Mo#i', 'EUW'), @('Moi', 'E#W')
)
foreach ($b in $badIds) {
    Check "riot_id refusé ($($b[0])/$($b[1]))" ($null -eq (Get-SafeRiotId $b[0] $b[1]))
}
Check 'riot_id 32/8 caractères' ($null -ne (Get-SafeRiotId ('é' * 32) 'ABCDEFGH'))

# Nom d'un joueur de la sélection : seulement s'il est affiché par le client.
$visCases = @(
    @{ Name = 'VISIBLE'; Json = '{"gameName":"Ami","tagLine":"EUW","nameVisibilityType":"VISIBLE"}'; Want = 'Ami#EUW' }
    @{ Name = 'visible (casse)'; Json = '{"gameName":"Ami","tagLine":"EUW","nameVisibilityType":"visible"}'; Want = 'Ami#EUW' }
    @{ Name = 'sans nameVisibilityType'; Json = '{"gameName":"Ami","tagLine":"EUW"}'; Want = 'Ami#EUW' }
    @{ Name = 'HIDDEN avec nom'; Json = '{"gameName":"Ami","tagLine":"EUW","nameVisibilityType":"HIDDEN"}'; Want = '' }
    @{ Name = 'UNHIDDEN autre valeur'; Json = '{"gameName":"Ami","tagLine":"EUW","nameVisibilityType":"UNHIDDEN"}'; Want = '' }
    @{ Name = 'nameVisibilityType vide'; Json = '{"gameName":"Ami","tagLine":"EUW","nameVisibilityType":""}'; Want = '' }
    @{ Name = 'nameVisibilityType nombre'; Json = '{"gameName":"Ami","tagLine":"EUW","nameVisibilityType":1}'; Want = '' }
    @{ Name = 'VISIBLE sans nom'; Json = '{"gameName":"","tagLine":"","nameVisibilityType":"VISIBLE"}'; Want = '' }
    @{ Name = 'VISIBLE sans tag'; Json = '{"gameName":"Ami","tagLine":"","nameVisibilityType":"VISIBLE"}'; Want = '' }
    @{ Name = 'summonerName seul'; Json = '{"summonerName":"Ami","playerAlias":"Ami","nameVisibilityType":"VISIBLE"}'; Want = '' }
)
foreach ($c in $visCases) {
    $got = Format-RiotId (Get-VisibleRiotId (ConvertFrom-Json $c.Json))
    Check "nom visible : $($c.Name)" ($got -eq $c.Want) "-> '$got'"
}

# --- Contrat CompanionPayload v2 sur une session réelle (ban_pick) ---
$p = ConvertTo-CompanionPayload -Session (Load 'session-banpick.json') -Puuid $local -RiotId $rid -QueueId 420 -SentAt $at
$expected = Canon (Load 'expected-banpick.json')
$actual = ConvertTo-PayloadJson $p
Check 'ban_pick = expected-banpick.json' ($actual -eq (Canon (ConvertFrom-Json $actual)) -and (Canon (ConvertFrom-Json $actual)) -eq $expected) "`n attendu : $expected`n obtenu  : $actual"

# --- Classée : aucun nom masqué par le client, aucune identité adverse ---
foreach ($f in @('session-planning.json', 'session-banpick.json', 'session-finalization.json', 'session-game-starting.json')) {
    $sess = Load $f
    $json = ConvertTo-PayloadJson (ConvertTo-CompanionPayload -Session $sess -Puuid $local -RiotId $rid -QueueId 420)
    Check "pas d'identité adverse ni de nom masqué ($f)" ($json -notmatch 'SECRET' -and $json -notmatch 'obf-enemy' -and $json -notmatch '99000' -and
        $json -notmatch 'gameName' -and $json -notmatch 'summonerId' -and $json -notmatch '104857601') $json
    $o = ConvertFrom-Json $json
    Check "version 2 + riot_id local ($f)" ($o.version -eq 2 -and $o.puuid -eq $local -and $o.riot_id.game_name -eq 'Moi' -and $o.riot_id.tag_line -eq 'EUW')
    foreach ($m in @($o.my_team)) {
        $src = @($sess.myTeam | Where-Object { $_.cellId -eq $m.cell })[0]
        Check "my_team : puuid du client tel quel ($f, $($m.cell))" ($m.puuid -eq $src.puuid)
        $names = @($m.PSObject.Properties | ForEach-Object { $_.Name }) -join ','
        if ($m.cell -eq 2 -or $m.cell -eq 3) {
            Check "my_team : nom affiché transmis ($f, $($m.cell))" ($names -eq 'cell,puuid,riot_id,champion_key,intent_key,position' -and
                $m.riot_id.game_name -eq $src.gameName -and $m.riot_id.tag_line -eq $src.tagLine) $names
        } else {
            Check "my_team : nom masqué non transmis ($f, $($m.cell))" ($names -eq 'cell,puuid,champion_key,intent_key,position') $names
        }
    }
    foreach ($e in @($o.their_team)) {
        $names = @($e.PSObject.Properties | ForEach-Object { $_.Name }) -join ','
        Check "their_team = cell,puuid,champion_key ($f)" ($names -eq 'cell,puuid,champion_key') $names
        Check "classée : puuid adverse vide ($f)" ($e.puuid -eq '') $e.puuid
    }
}

# --- Adversaires révélés par le client (Clash / tournoi / personnalisée) ---
$rs = Load 'session-revealed-banpick.json'
$rj = ConvertTo-PayloadJson (ConvertTo-CompanionPayload -Session $rs -Puuid $local -RiotId $rid -QueueId 700)
$r = ConvertFrom-Json $rj
Check 'révélés : 5 adversaires' (@($r.their_team).Count -eq 5)
for ($i = 0; $i -lt 5; $i++) {
    $names = @($r.their_team[$i].PSObject.Properties | ForEach-Object { $_.Name }) -join ','
    Check "révélés : puuid + nom affichés par le client ($i)" ($r.their_team[$i].puuid -eq $rs.theirTeam[$i].puuid -and $r.their_team[$i].cell -eq $rs.theirTeam[$i].cellId -and
        $names -eq 'cell,puuid,riot_id,champion_key' -and $r.their_team[$i].riot_id.game_name -eq $rs.theirTeam[$i].gameName -and $r.their_team[$i].riot_id.tag_line -eq 'CLASH') $rj
}
Check 'révélés : ni summonerId ni identifiant masqué' ($rj -notmatch '88000' -and $rj -notmatch 'gameName' -and $rj -notmatch 'obfuscated') $rj
Check 'révélés : le reste inchangé' ((ConvertTo-PayloadJson $r.my_team) -eq (ConvertTo-PayloadJson (ConvertFrom-Json (ConvertTo-PayloadJson $p)).my_team))

# puuid adverse : uniquement le champ puuid du client, non vide et au format attendu ; jamais un autre champ.
$okPuuid = 'b7e2c1a4-5d3f-4e6a-9b8c-0f1e2d3c4b5a'
$enemyCases = @(
    @{ Name = 'puuid valide'; Json = '{"cellId":5,"puuid":"' + $okPuuid + '"}'; Want = $okPuuid }
    @{ Name = 'puuid vide (classée)'; Json = '{"cellId":5,"puuid":"","obfuscatedPuuid":"' + $okPuuid + '","summonerId":990005,"gameName":"' + $okPuuid + '"}'; Want = '' }
    @{ Name = 'puuid absent'; Json = '{"cellId":5,"obfuscatedPuuid":"' + $okPuuid + '"}'; Want = '' }
    @{ Name = 'puuid null'; Json = '{"cellId":5,"puuid":null}'; Want = '' }
    @{ Name = 'puuid nombre'; Json = '{"cellId":5,"puuid":12345678901234567890123456789012345678901234567890}'; Want = '' }
    @{ Name = 'puuid format API Riot'; Json = '{"cellId":5,"puuid":"' + $riotApiPuuid + '"}'; Want = $riotApiPuuid }
    @{ Name = 'puuid non conforme'; Json = '{"cellId":5,"puuid":"SECRET/ENEMY PUUID"}'; Want = '' }
    @{ Name = 'puuid trop court'; Json = '{"cellId":5,"puuid":"abc"}'; Want = '' }
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
$n = ConvertTo-PayloadJson (New-NonePayload $local $rid 420 2 $at)
Check 'none' ($n -eq ('{"version":2,"puuid":"' + $local + '","riot_id":{"game_name":"Moi","tag_line":"EUW"},"phase":"none","queue_id":420,"local_cell":2,"my_team":[],"their_team":[],"bans":{"mine":[],"theirs":[]},"actions":[],"timer_remaining_ms":0,"sent_at":"' + $at + '"}')) $n
$n0 = ConvertFrom-Json (ConvertTo-PayloadJson (ConvertTo-CompanionPayload -Session (Load 'session-banpick.json') -Puuid ''))
Check 'puuid local vide accepté' ($n0.puuid -eq '' -and $null -eq $n0.riot_id)

# --- Diagnostic : réponses du client, identités des autres joueurs masquées ---
$diagState = @{
    Connection = @{ Source = 'lockfile C:\Riot Games\League of Legends\lockfile'; Port = 54321; Auth = 'Basic cmlvdDpzZWNyZXQ=' }
    StatusKey  = 'idle-Lobby'
    Diag       = @{
        Summoner = @{ Status = 200; At = $at; Body = $summoner }
        Gameflow = @{ Status = 200; At = $at; Body = 'ChampSelect' }
        Session  = @{ Status = 200; At = $at; Body = (Load 'session-revealed-banpick.json'); Summoner = $summoner }
    }
}
$dj = ConvertTo-Json -InputObject (New-DiagnosticDocument $diagState $at) -Depth 16
$d = ConvertFrom-Json $dj
Check 'diagnostic : compte local conservé' ($d.current_summoner.body.gameName -eq 'Moi' -and $d.current_summoner.body.puuid -eq $local -and $d.current_summoner.body.summonerId -eq $summoner.summonerId)
Check 'diagnostic : phase' ($d.gameflow_phase.body -eq 'ChampSelect')
$dm = @($d.champ_select_session.body.myTeam)
Check 'diagnostic : joueur local dans la sélection conservé' ($dm[2].gameName -eq 'Moi' -and $dm[2].puuid -eq $local)
Check 'diagnostic : allié masqué' ($dm[3].gameName -eq '<masqué>' -and $dm[3].tagLine -eq '<masqué>' -and $dm[3].puuid -eq '<masqué>' -and $dm[3].summonerId -eq '<masqué>' -and $dm[3].nameVisibilityType -eq 'VISIBLE')
Check 'diagnostic : valeurs vides gardées' ($dm[0].gameName -eq '' -and $dm[0].summonerId -eq 0 -and $dm[0].puuid -eq '<masqué>')
$de = @($d.champ_select_session.body.theirTeam)
Check 'diagnostic : adversaires masqués' (@($de | Where-Object { $_.gameName -ne '<masqué>' -or $_.puuid -ne '<masqué>' -or $_.summonerId -ne '<masqué>' }).Count -eq 0)
Check 'diagnostic : reste de la session intact' ($d.champ_select_session.body.timer.phase -eq 'BAN_PICK' -and @($d.champ_select_session.body.actions).Count -eq @($rs.actions).Count -and
    $d.champ_select_session.body.localPlayerCellId -eq 2 -and $de[0].championId -eq 122)
Check 'diagnostic : aucun nom ni identifiant d''un autre joueur' ($dj -notmatch 'Ami' -and $dj -notmatch 'VisibleEnemy' -and $dj -notmatch 'CLASH' -and $dj -notmatch '88000' -and
    $dj -notmatch '104857601' -and $dj -notmatch [regex]::Escape($rs.myTeam[3].puuid) -and $dj -notmatch [regex]::Escape($rs.theirTeam[0].puuid)) $dj
Check 'diagnostic : sans jeton du client' ($dj -notmatch 'cmlvd' -and $dj -match '54321')
Check 'diagnostic : interprétation' ($d.interpretation.local_riot_id -eq 'Moi#EUW' -and $d.interpretation.local_puuid_accepted -eq $true)
$ranked = ConvertFrom-Json (ConvertTo-Json -InputObject (ConvertTo-RedactedLcu (Load 'session-banpick.json') (Get-LocalIdentity $summoner (Load 'session-banpick.json'))) -Depth 16)
$rjson = ConvertTo-Json -InputObject $ranked -Depth 16 -Compress
Check 'diagnostic classée : noms masqués' ($rjson -notmatch 'SECRET' -and $rjson -notmatch 'obf-enemy' -and $rjson -notmatch '99000' -and $rjson -match '"gameName":"Moi"') $rjson
# Secrets de discussion, objets imbriqués, tableaux à un élément, compte au puuid inattendu.
$odd = ConvertFrom-Json '{"localPlayerCellId":0,"chatDetails":{"multiUserChatId":"room-1","multiUserChatPassword":"pw","mucJwtDto":{"jwt":"eyJ.abc","domain":"champ-select"}},"myTeam":[{"cellId":1,"puuid":"x-y","accountId":77,"obfuscatedSummonerId":5,"internalName":"ally","nested":{"gameName":"deep","tagLine":"X"}}]}'
$oj = ConvertTo-Json -InputObject (ConvertTo-RedactedLcu $odd (Get-LocalIdentity $null $odd)) -Depth 16 -Compress
Check 'diagnostic : secrets et champs imbriqués masqués' ($oj -notmatch 'room-1' -and $oj -notmatch '"pw"' -and $oj -notmatch 'eyJ' -and $oj -notmatch 'x-y' -and $oj -notmatch '77' -and
    $oj -notmatch 'ally' -and $oj -notmatch 'deep' -and $oj -match '"domain":"champ-select"' -and $oj -match '"myTeam":\[\{') $oj
$weird = ConvertFrom-Json '{"puuid":"not a uuid!","gameName":"","tagLine":"","summonerId":9}'
$wd = ConvertFrom-Json (ConvertTo-Json -InputObject (New-DiagnosticDocument @{ Connection = $null; StatusKey = 'no-riot-id'; Diag = @{ Summoner = @{ Status = 200; At = $at; Body = $weird }; Gameflow = $null; Session = $null } } $at) -Depth 16)
Check 'diagnostic : compte local brut (puuid refusé visible)' ($wd.current_summoner.body.puuid -eq 'not a uuid!' -and $wd.interpretation.local_puuid_accepted -eq $false -and $wd.interpretation.local_riot_id -eq '' -and $wd.lcu_connected -eq $false)

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
