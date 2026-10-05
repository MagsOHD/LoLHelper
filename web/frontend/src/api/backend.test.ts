import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AUTH_REQUIRED_EVENT, apiUrl, backendRequest, setPassword, store } from './backend';
import { installWindow, json } from './__fixtures__/fakes';
import { failure } from './__fixtures__/fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backend wrapper', () => {
  it('builds URLs from apiBase (trailing slash trimmed) and encodes params', () => {
    installWindow('https://example.fr/');
    expect(apiUrl('riot/account', { platform: 'euw1', gameName: 'Le Fou Élégant', tagLine: 'EUW', x: undefined })).toBe(
      'https://example.fr/api/index.php?r=riot%2Faccount&platform=euw1&gameName=Le+Fou+%C3%89l%C3%A9gant&tagLine=EUW',
    );
    installWindow('');
    expect(apiUrl('meta')).toBe('/api/index.php?r=meta');
  });

  it('sends the stored password and JSON body', async () => {
    installWindow('');
    setPassword('secret');
    const fetchMock = vi.fn(async () => json({ id: 'a', x: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const doc = await store.put('teams', { id: 'a', x: 1 });
    expect(doc).toEqual({ id: 'a', x: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/index.php?r=store%2Fteams%2Fa');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['X-App-Password']).toBe('secret');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ id: 'a', x: 1 });
  });

  it('omits the header without password', async () => {
    installWindow('');
    const fetchMock = vi.fn(async () => json([]));
    vi.stubGlobal('fetch', fetchMock);
    await store.list('players');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['X-App-Password']).toBeUndefined();
  });

  it('dispatches the auth-required event on 401 and throws the French detail', async () => {
    const win = installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Mot de passe requis ou incorrect.' }, 401)));
    const err = await failure(backendRequest('GET', 'store/players'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Mot de passe requis ou incorrect.');
    expect(win.dispatchEvent).toHaveBeenCalledTimes(1);
    expect((win.dispatchEvent.mock.calls[0] as unknown as [Event])[0].type).toBe(AUTH_REQUIRED_EVENT);
  });

  it('maps network errors, 429 Retry-After and store 404', async () => {
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('down'))));
    const net = await failure(backendRequest('GET', 'meta'));
    expect(net.status).toBe(0);
    expect(net.message).toMatch(/Impossible de joindre le serveur/);

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Limite' }, 429, { 'Retry-After': '4' })));
    const rl = await failure(backendRequest('GET', 'riot/summoner'));
    expect([rl.status, rl.retryAfter, rl.message]).toEqual([429, 4, 'Limite']);

    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Document introuvable.' }, 404)));
    expect(await store.remove('players', 'x')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json(null, 204)));
    expect(await store.remove('players', 'x')).toBe(true);
  });

  it('reports a non-JSON 200 (PHP not executed)', async () => {
    installWindow('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<?php echo 1;', { status: 200 })));
    const err = await failure(backendRequest('GET', 'meta'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toMatch(/PHP/);
  });
});
