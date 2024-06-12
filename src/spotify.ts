import { authentication, AuthenticationProvider, AuthenticationProviderAuthenticationSessionsChangeEvent, AuthenticationSession, env, Event, EventEmitter, Uri } from "vscode";
import { SpotifyUriHandler } from "./uriHandler";
import * as crypto from 'crypto';
import { AccessToken, SpotifyApi } from "@spotify/web-api-ts-sdk";
import { BetterTokenStorage } from "./betterSecretStorage";

const clientId = '9646f25e38854db48469def03ca04c98';
const redirectUrl = 'https://vscode.dev/redirect';

export const defaultScopes = ['user-read-private', 'user-read-email', 'user-read-playback-state', 'user-modify-playback-state'];

const authorizationEndpoint = "https://accounts.spotify.com/authorize";
const tokenEndpoint = "https://accounts.spotify.com/api/token";

export interface UpdateableAuthenticationSession extends AuthenticationSession {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
}

export class SpotifyAuthProvider implements AuthenticationProvider {
    static readonly id = 'spotify';
    static readonly label = 'Spotify';
    
    private _onDidChangeSessions: EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent> = new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
    onDidChangeSessions: Event<AuthenticationProviderAuthenticationSessionsChangeEvent> = this._onDidChangeSessions.event;

    // TODO: Save these sessions to disk
    private _sessions: UpdateableAuthenticationSession[] = [];
    // private _sessions2: Promise<UpdateableAuthenticationSession[]>;

    constructor(private readonly _uriHandler: SpotifyUriHandler, private readonly _tokenStorage: BetterTokenStorage<UpdateableAuthenticationSession>) {
        // this_sessions2 = _tokenStorage.getAll();
    }

    getSessions(scopes?: readonly string[]): Thenable<readonly AuthenticationSession[]> {
        return Promise.resolve(this._sessions
            .filter(session => !scopes || scopes.every(scope => session.scopes.includes(scope)))
            .map(s => ({
                id: s.id,
                accessToken: s.accessToken,
                scopes: s.scopes,
                account: s.account
            }))
        );
    }

    async createSession(scopes: readonly string[]): Promise<AuthenticationSession> {
        const codeVerifier = this._createCodeVerifier();
        const codeChallenge = await this.createCodeChallenge(codeVerifier);
        await this.openSpotifyAuthUri(scopes.join(' '), codeChallenge);
        const uri = await this._uriHandler.waitForUri();
        const code = new URLSearchParams(uri.query).get('code');
        if (!code) {
            throw new Error('No code found in URI');
        }
        const response = await this.exchangeCodeForToken(code, codeVerifier);
        const { display_name, id } = await this.getUserInfo(response.access_token);
        const session: UpdateableAuthenticationSession = {
            id: response.access_token,
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            expiresIn: response.expires_in,
            scopes,
            account: {
                label: display_name,
                id
            }
        };
        this._sessions.push(session);
        this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
        setTimeout(() => this.refreshTokens(), response.expires_in * 1000 * 2/3);
        return {
            id: session.id,
            accessToken: session.accessToken,
            scopes: session.scopes,
            account: session.account
        };
    }

    removeSession(sessionId: string): Thenable<void> {
        const sessionIndex = this._sessions.findIndex(session => session.id === sessionId);
        if (sessionIndex !== -1) {
            const [session] = this._sessions.splice(sessionIndex, 1);
            this._onDidChangeSessions.fire({ added: [], removed: [session], changed: [] });
        }
        return Promise.resolve();
    }

    async getSpotifyClient(scopes: string[] = defaultScopes) {
        let auth = this._sessions.find(session => scopes.every(scope => session.scopes.includes(scope)));
        if (!auth) {
            await authentication.getSession(SpotifyAuthProvider.id, scopes, { createIfNone: true });
            auth = this._sessions.find(session => scopes.every(scope => session.scopes.includes(scope)));
            if (!auth) {
                throw new Error('Failed to get Spotify client');
            }
        }
        const client = SpotifyApi.withAccessToken(clientId, {
            access_token: auth.accessToken,
            expires_in: auth.expiresIn,
            refresh_token: auth.refreshToken,
            token_type: 'Bearer',
        });
        return client;
    }

    private _createCodeVerifier(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const randomValues = crypto.getRandomValues(new Uint8Array(64));
        const randomString = randomValues.reduce((acc, x) => acc + possible[x % possible.length], "");
        return randomString;
    }

    private async createCodeChallenge(codeVerifier: string): Promise<string> {
        const data = new TextEncoder().encode(codeVerifier);
        const hashed = await crypto.subtle.digest('SHA-256', data);

        const code_challenge_base64 = btoa(String.fromCharCode(...new Uint8Array(hashed)))
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
        return code_challenge_base64;
    }

    private async openSpotifyAuthUri(
        scope: string,
        codeChallenge: string
    ): Promise<boolean> {
        const redirectTo = await env.asExternalUri(Uri.parse(`${env.uriScheme}://joyceerhl.vscode-gptheme/authenticate`));
        const authUrl = new URL(authorizationEndpoint);
        authUrl.search = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            scope: scope,
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
            state: redirectTo.toString(true),
            redirect_uri: redirectUrl,
        }).toString();
        return await env.openExternal(Uri.parse(authUrl.toString()));
    }

    private async exchangeCodeForToken(code: string, codeVerifier: string): Promise<AccessToken> {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUrl,
            client_id: clientId,
            code_verifier: codeVerifier,
        }).toString();
        const response = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const json = await response.json() as any;
        return json;
    }

    private async refreshTokens(): Promise<void> {
        for (const session of this._sessions) {
            const newAccessToken = await this.refreshAccessToken(session.refreshToken);
            session.accessToken = newAccessToken;
        }
        setTimeout(() => this.refreshTokens(), this._sessions[0].expiresIn * 1000 * 2/3);
    }

    private async refreshAccessToken(refreshToken: string): Promise<string> {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
        }).toString();
        const response = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        const json = await response.json() as any;
        return json.access_token;
    }

    private async getUserInfo(accessToken: string): Promise<{ display_name: string, id: string }> {
        const response = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        return await response.json() as any;
    }
}
