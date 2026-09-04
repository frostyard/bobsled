import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { RepositoryIdSchema, type RepositoryContract } from './contracts.ts';
import type { Principal } from './ledger.ts';
import { ensureMultiRepositoryChangeSetSchema } from './multi-repository-change-set-schema.ts';
import { MultiRepositoryPublicationAuthorizationStore, type MultiRepositoryPublicationAuthorization } from './multi-repository-publication-authorization-store.ts';
import { repositories as enrolledRepositories } from './repositories.ts';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const PublicationStatusSchema = v.picklist(['blocked', 'pending', 'running', 'published', 'checks_pending', 'checks_failed', 'ready_for_human', 'merged', 'closed', 'failed']);

export const MultiRepositoryPublicationExecutionMemberSchema = v.object({
	repositoryId: RepositoryIdSchema,
	publicationId: v.pipe(v.string(), v.uuid()),
	runId: v.pipe(v.string(), v.uuid()),
	reviewId: v.pipe(v.string(), v.uuid()),
	patchSha256: Sha256Schema,
	branchName: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
	marker: v.pipe(v.string(), v.minLength(1)),
	status: PublicationStatusSchema,
	rolloutLayer: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(15)),
});

export const MultiRepositoryPublicationExecutionManifestSchema = v.object({
	version: v.literal(1),
	executionId: v.pipe(v.string(), v.uuid()),
	authorizationId: v.pipe(v.string(), v.uuid()),
	members: v.pipe(v.array(MultiRepositoryPublicationExecutionMemberSchema), v.minLength(2), v.maxLength(16)),
	githubMutationAuthorized: v.literal(false),
	rolloutAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
});

export const MultiRepositoryPublicationExecutionResultSchema = v.object({
	manifestSha256: Sha256Schema,
	status: v.picklist(['succeeded', 'partial', 'blocked', 'failed']),
	members: v.pipe(v.array(MultiRepositoryPublicationExecutionMemberSchema), v.minLength(2), v.maxLength(16)),
	failedRepositoryId: v.optional(RepositoryIdSchema),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(4_000)),
	rolloutAuthorized: v.literal(false),
	mergeAuthorized: v.literal(false),
});

export const MultiRepositoryPublicationExecutionSchema = v.object({
	id: v.pipe(v.string(), v.uuid()),
	authorizationId: v.pipe(v.string(), v.uuid()),
	changeSetId: v.pipe(v.string(), v.uuid()),
	ownerId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
	status: v.picklist(['reserved', 'prepared', 'running', 'succeeded', 'partial', 'blocked', 'failed']),
	publicationsStarted: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(16)),
	authorizationSha256: Sha256Schema,
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)),
	createdAt: v.string(), startedAt: v.optional(v.string()), finishedAt: v.optional(v.string()),
	manifest: v.optional(MultiRepositoryPublicationExecutionManifestSchema),
	manifestSha256: v.optional(Sha256Schema),
	result: v.optional(MultiRepositoryPublicationExecutionResultSchema),
	publicationExecutionAuthorized: v.boolean(),
	rolloutAuthorized: v.literal(false), mergeAuthorized: v.literal(false),
});

const ReserveSchema = v.object({ authorizationId: v.pipe(v.string(), v.uuid()), reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_000)) });
export type MultiRepositoryPublicationExecutionMember = v.InferOutput<typeof MultiRepositoryPublicationExecutionMemberSchema>;
export type MultiRepositoryPublicationExecutionManifest = v.InferOutput<typeof MultiRepositoryPublicationExecutionManifestSchema>;
export type MultiRepositoryPublicationExecutionResult = v.InferOutput<typeof MultiRepositoryPublicationExecutionResultSchema>;
export type MultiRepositoryPublicationExecution = v.InferOutput<typeof MultiRepositoryPublicationExecutionSchema>;
export class MultiRepositoryPublicationExecutionConflictError extends Error {}
export class MultiRepositoryPublicationExecutionForbiddenError extends Error {}
export class MultiRepositoryPublicationExecutionNotFoundError extends Error {}

interface Row { id:string; authorization_id:string; change_set_id:string; owner_id:string; idempotency_key:string; request_sha256:string; authorization_sha256:string; reason:string; status:string; publications_started:number; created_at:string; started_at:string|null; finished_at:string|null; result_sha256:string|null; result_json:string|null }
interface PreflightRow { manifest_sha256:string; manifest_json:string; created_at:string }
function canonical(value:unknown):unknown { if(Array.isArray(value)) return value.map(canonical); if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])); return value; }
function digest(value:unknown):string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function authorizationDigest(value:MultiRepositoryPublicationAuthorization):string { return digest({ id:value.id, compatibilityExecutionId:value.compatibilityExecutionId, changeSetId:value.changeSetId, memberSetSha256:value.memberSetSha256, members:value.members, rolloutLayers:value.rolloutLayers, rollbackLayers:value.rollbackLayers }); }

export class MultiRepositoryPublicationExecutionStore {
	readonly #db:Database.Database; readonly #authorizations:MultiRepositoryPublicationAuthorizationStore; readonly #now:()=>Date;
	constructor(path=dataPath('bobsled.db'), now:()=>Date=()=>new Date(), repositories:readonly RepositoryContract[]=enrolledRepositories) {
		if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700}); this.#db=new Database(path); if(path!==':memory:') chmodSync(path,0o600);
		this.#db.pragma('foreign_keys = ON'); this.#db.pragma('journal_mode = WAL'); this.#db.pragma('busy_timeout = 5000'); this.#db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'); ensureMultiRepositoryChangeSetSchema(this.#db);
		this.#authorizations=new MultiRepositoryPublicationAuthorizationStore(path,now,repositories); this.#now=now;
	}
	close():void { this.#authorizations.close(); this.#db.close(); }
	authorizationFor(id:string,principal:Principal):MultiRepositoryPublicationAuthorization { const execution=this.get(id,principal); return this.#authorizations.get(execution.authorizationId,principal); }
	reserve(input:unknown, principal:Principal, idempotencyKey:string):MultiRepositoryPublicationExecution {
		const request=v.parse(ReserveSchema,input); if(!idempotencyKey||idempotencyKey.length>200) throw new MultiRepositoryPublicationExecutionConflictError('A bounded Idempotency-Key is required'); const requestSha256=digest(request);
		const replay=this.#findReplay(principal.id,idempotencyKey); if(replay){if(replay.request_sha256!==requestSha256) throw new MultiRepositoryPublicationExecutionConflictError('Idempotency key was already used for different input'); return this.get(replay.id,principal);}
		const authorization=this.#authorizations.get(request.authorizationId,principal);
		return this.#db.transaction(()=>{const concurrent=this.#findReplay(principal.id,idempotencyKey); if(concurrent){if(concurrent.request_sha256!==requestSha256) throw new MultiRepositoryPublicationExecutionConflictError('Idempotency key was already used for different input'); return this.get(concurrent.id,principal);} if(this.#db.prepare('SELECT id FROM multi_repository_publication_executions WHERE authorization_id=?').get(authorization.id)) throw new MultiRepositoryPublicationExecutionConflictError('This linked-publication authorization already has an execution'); const id=randomUUID(), createdAt=this.#now().toISOString(); this.#db.prepare(`INSERT INTO multi_repository_publication_executions (id,authorization_id,change_set_id,owner_id,idempotency_key,request_sha256,authorization_sha256,reason,status,created_at) VALUES (?,?,?,?,?,?,?,?,'reserved',?)`).run(id,authorization.id,authorization.changeSetId,principal.id,idempotencyKey,requestSha256,authorizationDigest(authorization),request.reason,createdAt); return this.get(id,principal);}).immediate();
	}
	get(id:string,principal:Principal):MultiRepositoryPublicationExecution {
		const row=this.#row(id); if(row.owner_id!==principal.id) throw new MultiRepositoryPublicationExecutionForbiddenError('Linked-publication execution belongs to another principal'); const authorization=this.#authorizations.get(row.authorization_id,principal); const preflight=this.#db.prepare('SELECT * FROM multi_repository_publication_preflights WHERE execution_id=?').get(id) as PreflightRow|undefined;
		let manifest:MultiRepositoryPublicationExecutionManifest|undefined; if(preflight){try{manifest=v.parse(MultiRepositoryPublicationExecutionManifestSchema,JSON.parse(preflight.manifest_json));}catch{throw new MultiRepositoryPublicationExecutionConflictError('Stored linked-publication preflight is malformed');} const expectedByRepository=new Map(authorization.members.map((member)=>[member.repositoryId,member])); const expectedOrder=authorization.rolloutLayers.flat(); if(digest(manifest)!==preflight.manifest_sha256||manifest.executionId!==id||manifest.authorizationId!==authorization.id||manifest.members.length!==authorization.members.length||manifest.members.some((member,index)=>{const expected=expectedByRepository.get(member.repositoryId); return expectedOrder[index]!==member.repositoryId||!expected||member.runId!==expected.runId||member.reviewId!==expected.reviewId||member.patchSha256!==expected.patchSha256||member.rolloutLayer!==expected.rolloutLayer;})) throw new MultiRepositoryPublicationExecutionConflictError('Stored linked-publication preflight failed authorization integrity verification');}
		let result:MultiRepositoryPublicationExecutionResult|undefined; if(row.result_json){try{result=v.parse(MultiRepositoryPublicationExecutionResultSchema,JSON.parse(row.result_json));}catch{throw new MultiRepositoryPublicationExecutionConflictError('Stored linked-publication result is malformed');} if(!row.result_sha256||digest(result)!==row.result_sha256||result.manifestSha256!==preflight?.manifest_sha256||result.members.length!==manifest?.members.length||result.members.some((member,index)=>{const expected=manifest?.members[index]; return !expected||member.repositoryId!==expected.repositoryId||member.publicationId!==expected.publicationId||member.runId!==expected.runId||member.reviewId!==expected.reviewId||member.patchSha256!==expected.patchSha256||member.branchName!==expected.branchName||member.marker!==expected.marker||member.rolloutLayer!==expected.rolloutLayer;})) throw new MultiRepositoryPublicationExecutionConflictError('Stored linked-publication result failed integrity verification');}
		const terminal=['succeeded','partial','blocked','failed'].includes(row.status);
		const violations = [
			row.authorization_sha256!==authorizationDigest(authorization) ? 'authorization' : undefined,
			row.change_set_id!==authorization.changeSetId ? 'change_set' : undefined,
			digest({authorizationId:row.authorization_id,reason:row.reason})!==row.request_sha256 ? 'request' : undefined,
			(row.status==='reserved')!==!manifest ? 'reserved_manifest' : undefined,
			(['prepared','running'].includes(row.status)&&!manifest) ? 'active_manifest' : undefined,
			terminal!==Boolean(result) ? 'terminal_result' : undefined,
			(result&&result.status!==row.status) ? 'result_status' : undefined,
			(terminal&&!row.finished_at) ? 'terminal_time' : undefined,
			(!terminal&&Boolean(row.finished_at)) ? 'nonterminal_time' : undefined,
			(row.publications_started>(manifest?.members.length??0)) ? 'publication_count' : undefined,
			(row.status==='succeeded'&&row.publications_started!==manifest?.members.length) ? 'success_count' : undefined,
			(row.status==='partial'&&(row.publications_started<1||!result?.failedRepositoryId)) ? 'partial_shape' : undefined,
		].filter(Boolean);
		if(violations.length>0) throw new MultiRepositoryPublicationExecutionConflictError(`Stored linked-publication execution has invalid lifecycle or parent evidence: ${violations.join(', ')}`);
		return v.parse(MultiRepositoryPublicationExecutionSchema,{id:row.id,authorizationId:row.authorization_id,changeSetId:row.change_set_id,ownerId:row.owner_id,status:row.status,publicationsStarted:row.publications_started,authorizationSha256:row.authorization_sha256,reason:row.reason,createdAt:row.created_at,startedAt:row.started_at??undefined,finishedAt:row.finished_at??undefined,manifest,manifestSha256:preflight?.manifest_sha256,result,publicationExecutionAuthorized:row.status==='prepared',rolloutAuthorized:false,mergeAuthorized:false});
	}
	recordPreflight(id:string,input:unknown,principal:Principal):MultiRepositoryPublicationExecution { const manifest=v.parse(MultiRepositoryPublicationExecutionManifestSchema,input); this.#db.transaction(()=>{const current=this.get(id,principal), sha=digest(manifest); const prior=this.#db.prepare('SELECT * FROM multi_repository_publication_preflights WHERE execution_id=?').get(id) as PreflightRow|undefined; if(prior){if(prior.manifest_sha256!==sha) throw new MultiRepositoryPublicationExecutionConflictError('Linked-publication preflight is immutable'); return;} if(current.status!=='reserved') throw new MultiRepositoryPublicationExecutionConflictError('Only a reserved execution may record publication preflight'); this.#db.prepare('INSERT INTO multi_repository_publication_preflights (execution_id,manifest_sha256,manifest_json,created_at) VALUES (?,?,?,?)').run(id,sha,JSON.stringify(manifest),this.#now().toISOString()); const changed=this.#db.prepare("UPDATE multi_repository_publication_executions SET status='prepared' WHERE id=? AND status='reserved'").run(id); if(changed.changes!==1) throw new MultiRepositoryPublicationExecutionConflictError('Publication preflight raced with another process');}).immediate(); return this.get(id,principal); }
	claim(id:string,principal:Principal):{execution:MultiRepositoryPublicationExecution;newlyClaimed:boolean} { let newlyClaimed=false; this.#db.transaction(()=>{const current=this.get(id,principal); if(current.status==='running'||['succeeded','partial','blocked','failed'].includes(current.status)) return; if(current.status!=='prepared'||current.manifest?.members.some(({status})=>status!=='pending')) throw new MultiRepositoryPublicationExecutionConflictError('Every linked publication must be pending before execution claim'); const changed=this.#db.prepare("UPDATE multi_repository_publication_executions SET status='running',started_at=? WHERE id=? AND status='prepared' AND publications_started=0").run(this.#now().toISOString(),id); if(changed.changes!==1) throw new MultiRepositoryPublicationExecutionConflictError('Publication execution claim raced with another process'); newlyClaimed=true;}).immediate(); return {execution:this.get(id,principal),newlyClaimed}; }
	recordPublicationStart(id:string,principal:Principal,expectedIndex:number):MultiRepositoryPublicationExecution { this.#db.transaction(()=>{const current=this.get(id,principal); if(current.status!=='running'||current.publicationsStarted!==expectedIndex) throw new MultiRepositoryPublicationExecutionConflictError('Publication start does not match the one-use rollout sequence'); const changed=this.#db.prepare('UPDATE multi_repository_publication_executions SET publications_started=publications_started+1 WHERE id=? AND status=\'running\' AND publications_started=?').run(id,expectedIndex); if(changed.changes!==1) throw new MultiRepositoryPublicationExecutionConflictError('Publication start raced with another process');}).immediate(); return this.get(id,principal); }
	settle(id:string,input:unknown,principal:Principal):MultiRepositoryPublicationExecution { const result=v.parse(MultiRepositoryPublicationExecutionResultSchema,input); this.#db.transaction(()=>{const current=this.get(id,principal); if(['succeeded','partial','blocked','failed'].includes(current.status)){if(digest(current.result)!==digest(result)) throw new MultiRepositoryPublicationExecutionConflictError('Terminal linked-publication evidence is immutable'); return;} if(!current.manifestSha256||result.manifestSha256!==current.manifestSha256||!['prepared','running'].includes(current.status)) throw new MultiRepositoryPublicationExecutionConflictError('Only prepared or running publication execution may settle'); if(result.failedRepositoryId&&!result.members.some(({repositoryId})=>repositoryId===result.failedRepositoryId)) throw new MultiRepositoryPublicationExecutionConflictError('Failed repository is absent from the linked publication'); if(result.status==='succeeded'&&(result.failedRepositoryId||result.members.some(({status})=>!['published','checks_pending','checks_failed','ready_for_human'].includes(status)))) throw new MultiRepositoryPublicationExecutionConflictError('Successful linked publication requires every member draft to exist'); if(result.status==='partial'&&(rowPublished(result.members)===0||!result.failedRepositoryId)) throw new MultiRepositoryPublicationExecutionConflictError('Partial publication requires created draft and failed-member evidence'); if(current.status==='prepared'&&(result.status!=='blocked'||current.publicationsStarted!==0)) throw new MultiRepositoryPublicationExecutionConflictError('Only zero-side-effect preflight failure may settle before claim'); if(current.status==='running'&&result.members.some(({status},index)=>index<current.publicationsStarted?status==='pending':status!=='pending')) throw new MultiRepositoryPublicationExecutionConflictError('Terminal member states do not match the attempted rollout prefix'); const changed=this.#db.prepare("UPDATE multi_repository_publication_executions SET status=?,result_sha256=?,result_json=?,finished_at=? WHERE id=? AND status IN ('prepared','running')").run(result.status,digest(result),JSON.stringify(result),this.#now().toISOString(),id); if(changed.changes!==1) throw new MultiRepositoryPublicationExecutionConflictError('Publication settlement raced with another process');}).immediate(); return this.get(id,principal); }
	#row(id:string):Row { const row=this.#db.prepare('SELECT * FROM multi_repository_publication_executions WHERE id=?').get(id) as Row|undefined; if(!row) throw new MultiRepositoryPublicationExecutionNotFoundError('Linked-publication execution was not found'); return row; }
	#findReplay(ownerId:string,key:string):Row|undefined { return this.#db.prepare('SELECT * FROM multi_repository_publication_executions WHERE owner_id=? AND idempotency_key=?').get(ownerId,key) as Row|undefined; }
}
function rowPublished(members:readonly MultiRepositoryPublicationExecutionMember[]):number { return members.filter(({status})=>['published','checks_pending','checks_failed','ready_for_human','merged'].includes(status)).length; }
