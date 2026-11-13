/** Download links (relative: the site may live in a sub-folder) and a short how-to for the companion. */
export const COMPANION_FILES = {
  launcher: 'companion/Lancer-LoLHelper-Draft.bat',
  script: 'companion/lolhelper-draft.ps1',
} as const;

function siteAddress(): string {
  if (typeof window === 'undefined') return '';
  return window.location.href.split('#')[0].replace(/index\.html?$/, '').replace(/\/+$/, '');
}

export function CompanionHelp({ open }: { open?: boolean }) {
  return (
    <details className="card companion" open={open}>
      <summary className="companion__summary">
        <span className="companion__title">Programme compagnon (Windows)</span>
        <span className="muted small">Remplit la draft tout seul depuis le client LoL</span>
      </summary>
      <div className="companion__body">
        <div className="row">
          <a className="btn btn--primary btn--sm" href={COMPANION_FILES.launcher} download>
            Télécharger le programme compagnon (Windows)
          </a>
          <a className="btn btn--ghost btn--sm" href={COMPANION_FILES.script} download>
            + script lolhelper-draft.ps1
          </a>
        </div>
        <ol className="steps">
          <li>Télécharge les <strong>deux fichiers</strong> et range-les dans le même dossier.</li>
          <li>
            Double-clique sur <code>Lancer-LoLHelper-Draft.bat</code>. Si Windows affiche un avertissement :
            « Informations complémentaires » puis « Exécuter quand même ».
          </li>
          <li>
            Au premier lancement, donne l’adresse du site{siteAddress() && <> (<code className="companion__url">{siteAddress()}</code>)</>} et le mot de passe partagé.
          </li>
          <li>Laisse la fenêtre ouverte : dès la sélection des champions, la draft s’affiche ici pour toute l’équipe.</li>
        </ol>
        <p className="hint">
          Lecture seule : le programme lit la sélection des champions du client et n’envoie que les champions, bans et rôles —
          jamais l’identité des adversaires. Ton Riot ID doit faire partie des joueurs du site.
        </p>
      </div>
    </details>
  );
}
