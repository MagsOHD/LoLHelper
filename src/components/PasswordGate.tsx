import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, AUTH_REQUIRED_EVENT, api, getPassword, setPassword } from '../api/client';
import { ErrorMessage } from './ui';

export function PasswordGate({ required, children }: { required: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const id = useId();
  const [locked, setLocked] = useState(() => required && !getPassword());
  const [value, setValue] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (required && !getPassword()) setLocked(true);
  }, [required]);

  useEffect(() => {
    const onAuthRequired = () => {
      setPassword('');
      setLocked(true);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  if (!locked) return <>{children}</>;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    setPassword(value.trim());
    try {
      await api.listTeams(); // cheapest call that requires the password
      setLocked(false);
      setValue('');
      await queryClient.invalidateQueries();
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError && err.status === 401 ? new Error('Mot de passe incorrect.') : (err as Error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="page">
      <form className="card password-gate" onSubmit={onSubmit}>
        <h1>Accès réservé</h1>
        <p className="muted">Entre le mot de passe partagé entre amis. Il sera retenu sur cet appareil.</p>
        <div className="field">
          <label className="field__label" htmlFor={id}>Mot de passe</label>
          <input
            id={id}
            className="input"
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </div>
        {error && <ErrorMessage error={error} />}
        <button type="submit" className="btn btn--primary" disabled={pending || !value.trim()}>
          {pending ? 'Vérification…' : 'Entrer'}
        </button>
      </form>
    </div>
  );
}
