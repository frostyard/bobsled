export const REQUIRED_GITHUB_ORGANIZATION = 'frostyard';

export interface OperatorAuthEnvironment {
	BOBSLED_OPERATOR_AUTH_MODE?: string;
	BOBSLED_GITHUB_CLIENT_ID?: string;
	BOBSLED_GITHUB_CLIENT_SECRET?: string;
	BOBSLED_SESSION_SECRET?: string;
	BOBSLED_PUBLIC_ORIGIN?: string;
}

export interface OperatorAuthConfiguration {
	clientId: string;
	clientSecret: string;
	sessionSecret: string;
	publicOrigin: string;
	callbackUrl: string;
}

export interface OperatorAuthStatus {
	mode: 'local_trusted' | 'github_unconfigured' | 'github';
	requiredOrganization: typeof REQUIRED_GITHUB_ORGANIZATION;
	clientIdConfigured: boolean;
	clientSecretConfigured: boolean;
	sessionSecretConfigured: boolean;
	publicOriginConfigured: boolean;
	publicOriginValid: boolean;
	configurationComplete: boolean;
	sessionImplementationReady: true;
}

function normalizedPublicOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
		if (url.pathname !== '/' && url.pathname !== '') return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

export function operatorAuthConfiguration(environment: OperatorAuthEnvironment = process.env): OperatorAuthConfiguration | undefined {
	const publicOrigin = normalizedPublicOrigin(environment.BOBSLED_PUBLIC_ORIGIN);
	if (!environment.BOBSLED_GITHUB_CLIENT_ID || !environment.BOBSLED_GITHUB_CLIENT_SECRET ||
		!environment.BOBSLED_SESSION_SECRET || environment.BOBSLED_SESSION_SECRET.length < 32 || !publicOrigin) return undefined;
	return {
		clientId: environment.BOBSLED_GITHUB_CLIENT_ID,
		clientSecret: environment.BOBSLED_GITHUB_CLIENT_SECRET,
		sessionSecret: environment.BOBSLED_SESSION_SECRET,
		publicOrigin,
		callbackUrl: `${publicOrigin}/auth/github/callback`,
	};
}

export function operatorAuthStatus(environment: OperatorAuthEnvironment = process.env): OperatorAuthStatus {
	const githubRequested = environment.BOBSLED_OPERATOR_AUTH_MODE === 'github';
	const publicOriginValid = Boolean(normalizedPublicOrigin(environment.BOBSLED_PUBLIC_ORIGIN));
	const configured = {
		clientIdConfigured: Boolean(environment.BOBSLED_GITHUB_CLIENT_ID),
		clientSecretConfigured: Boolean(environment.BOBSLED_GITHUB_CLIENT_SECRET),
		sessionSecretConfigured: Boolean(environment.BOBSLED_SESSION_SECRET && environment.BOBSLED_SESSION_SECRET.length >= 32),
		publicOriginConfigured: Boolean(environment.BOBSLED_PUBLIC_ORIGIN),
		publicOriginValid,
	};
	const configurationComplete = Boolean(operatorAuthConfiguration(environment));
	return {
		mode: githubRequested ? (configurationComplete ? 'github' : 'github_unconfigured') : 'local_trusted',
		requiredOrganization: REQUIRED_GITHUB_ORGANIZATION,
		...configured,
		configurationComplete,
		sessionImplementationReady: true,
	};
}

export function requestOriginAllowed(request: Request, configuration: OperatorAuthConfiguration): boolean {
	if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;
	return request.headers.get('origin') === configuration.publicOrigin;
}
