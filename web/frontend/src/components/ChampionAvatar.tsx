import { useState } from 'react';
import type { ChampionInfo } from '../api/types';
import { initials } from '../lib/format';

function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Square portrait with initials fallback (images may be offline). */
export function Avatar({ src, name, size = 40, round, className = '' }: {
  src?: string;
  name: string;
  size?: number;
  round?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  const cls = `avatar ${round ? 'avatar--round' : ''} ${className}`;
  if (src && !failed) {
    return <img className={cls} src={src} alt="" width={size} height={size} style={style} loading="lazy" onError={() => setFailed(true)} />;
  }
  const hue = hueOf(name);
  return (
    <span
      className={`${cls} avatar--initials`}
      style={{ ...style, background: `linear-gradient(135deg, hsl(${hue} 45% 38%), hsl(${(hue + 40) % 360} 50% 20%))` }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function ChampionAvatar({ champion, id, size = 40, showName, className }: {
  champion?: ChampionInfo;
  id?: string;
  size?: number;
  showName?: boolean;
  className?: string;
}) {
  const name = champion?.name ?? id ?? '?';
  const img = <Avatar src={champion?.image_url} name={name} size={size} className={className} />;
  if (!showName) {
    return <span className="champ-avatar" title={name}>{img}<span className="sr-only">{name}</span></span>;
  }
  return (
    <span className="champ-avatar champ-avatar--named">
      {img}
      <span className="champ-avatar__name">{name}</span>
    </span>
  );
}
