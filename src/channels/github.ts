import { createGitHubChannel } from '@flue/github';
import type { MiddlewareHandler } from 'hono';
import {
	githubEventStore,
	type GitHubEventStore,
	type RecordedWebhook,
	WebhookConflictError,
	WebhookForbiddenError,
	WebhookPayloadError,
} from '../control-plane/github-events.ts';

export const GITHUB_WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;

function webhookError(error: unknown): Response {
	const message = error instanceof Error ? error.message : 'Webhook admission failed';
	if (error instanceof WebhookForbiddenError) return Response.json({ error: message }, { status: 403 });
	if (error instanceof WebhookConflictError) return Response.json({ error: message }, { status: 409 });
	if (error instanceof WebhookPayloadError) return Response.json({ error: message }, { status: 400 });
	return Response.json({ error: 'Webhook admission failed' }, { status: 500 });
}

async function readBoundedClone(request: Request, limit: number): Promise<Uint8Array | undefined> {
	const clone = request.clone();
	if (!clone.body) return new Uint8Array();
	const reader = clone.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export function createBobsledGitHubChannel(options: {
	webhookSecret: string;
	store?: GitHubEventStore;
	bodyLimit?: number;
	onRecorded?: (delivery: RecordedWebhook) => Promise<void>;
}) {
	const store = options.store ?? githubEventStore;
	const bodyLimit = options.bodyLimit ?? GITHUB_WEBHOOK_BODY_LIMIT;
	const exactBodies = new WeakMap<Request, Uint8Array>();

	const channel = createGitHubChannel({
		webhookSecret: options.webhookSecret,
		bodyLimit,
		async webhook({ c, delivery }) {
			const payload = exactBodies.get(c.req.raw);
			if (!payload) return Response.json({ error: 'Verified webhook bytes are unavailable' }, { status: 500 });
			try {
				const recorded = store.recordVerified({
					deliveryId: delivery.deliveryId,
					eventName: delivery.name,
					payload,
					decodedPayload: delivery.payload,
				});
				await options.onRecorded?.(recorded);
				return Response.json(recorded, { status: 202 });
			} catch (error) {
				return webhookError(error);
			}
		},
	});

	const captureExactBody: MiddlewareHandler = async (context, next) => {
		const request = context.req.raw;
		const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
		const contentLength = request.headers.get('content-length');
		const mayBeAdmissible = contentType === 'application/json' &&
			(contentLength === null || (/^\d+$/.test(contentLength) && Number(contentLength) <= bodyLimit));
		const body = mayBeAdmissible ? await readBoundedClone(request, bodyLimit) : undefined;
		if (body) exactBodies.set(request, body);
		try {
			await next();
			if (context.res.status === 200 && context.req.header('x-github-event') === 'ping' && body) {
				try {
					store.recordVerified({
						deliveryId: context.req.header('x-github-delivery') ?? '',
						eventName: 'ping',
						payload: body,
						decodedPayload: JSON.parse(new TextDecoder().decode(body)),
					});
				} catch (error) {
					context.res = webhookError(error);
				}
			}
		} finally {
			exactBodies.delete(request);
		}
	};

	return { channel, captureExactBody };
}
