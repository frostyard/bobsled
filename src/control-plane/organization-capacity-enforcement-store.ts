import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as v from 'valibot';
import { dataPath } from '../paths.ts';
import { ensureOrganizationCapacityPolicySchema, readCurrentOrganizationCapacityPolicy } from './organization-capacity-policy-store.ts';

const PrincipalSchema = v.object({ id: v.pipe(v.string(),v.minLength(1),v.maxLength(200)) });
const RecordRequestSchema = v.object({
	mode: v.picklist(['enabled','disabled']),
	expectedVersion: v.pipe(v.number(),v.integer(),v.minValue(0)),
	expectedPolicyVersion: v.pipe(v.number(),v.integer(),v.minValue(1)),
	reason: v.pipe(v.string(),v.minLength(1),v.maxLength(1_000)),
});

interface EnforcementRow { id:string;version:number;mode:string;policy_version:number;policy_sha256:string;actor_id:string;idempotency_key:string;request_sha256:string;event_sha256:string;reason:string;created_at:string; }
export interface OrganizationCapacityEnforcementRecord { id:string;version:number;mode:'enabled'|'disabled';policyVersion:number;policySha256:string;actorId:string;reason:string;createdAt:string; }
export interface OrganizationCapacityEnforcementState { mode:'disabled'|'enabled'|'blocked_policy_drift'; record?:OrganizationCapacityEnforcementRecord; }
export class OrganizationCapacityEnforcementConflictError extends Error {}
export class OrganizationCapacityEnforcementIntegrityError extends Error {}

function canonical(value:unknown):unknown { if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));return value; }
function digest(value:unknown):string{return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function readRow(db:Database.Database,row:EnforcementRow):OrganizationCapacityEnforcementRecord {
	const validMode=row.mode==='enabled'||row.mode==='disabled';
	const request={mode:row.mode,expectedVersion:row.version-1,expectedPolicyVersion:row.policy_version,reason:row.reason};
	const event={id:row.id,version:row.version,mode:row.mode,policyVersion:row.policy_version,policySha256:row.policy_sha256,actorId:row.actor_id,idempotencyKey:row.idempotency_key,requestSha256:row.request_sha256,reason:row.reason,createdAt:row.created_at};
	const policy=db.prepare('SELECT policy_sha256 FROM organization_capacity_policy_events WHERE version=?').get(row.policy_version) as {policy_sha256:string}|undefined;
	if(!validMode||row.version<1||row.policy_version<1||!Number.isFinite(Date.parse(row.created_at))||!policy||policy.policy_sha256!==row.policy_sha256||row.request_sha256!==digest(request)||row.event_sha256!==digest(event))throw new OrganizationCapacityEnforcementIntegrityError('Stored organization capacity enforcement event failed integrity verification');
	return{id:row.id,version:row.version,mode:row.mode as 'enabled'|'disabled',policyVersion:row.policy_version,policySha256:row.policy_sha256,actorId:row.actor_id,reason:row.reason,createdAt:row.created_at};
}

export function ensureOrganizationCapacityEnforcementSchema(db:Database.Database):void {
	ensureOrganizationCapacityPolicySchema(db);
	db.exec(`CREATE TABLE IF NOT EXISTS organization_capacity_enforcement_events (
		id TEXT PRIMARY KEY,version INTEGER NOT NULL UNIQUE,mode TEXT NOT NULL,policy_version INTEGER NOT NULL,policy_sha256 TEXT NOT NULL,
		actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,event_sha256 TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,
		UNIQUE(actor_id,idempotency_key));
		INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (52,datetime('now'));`);
}

export function readCurrentOrganizationCapacityEnforcement(db:Database.Database):OrganizationCapacityEnforcementState {
	ensureOrganizationCapacityEnforcementSchema(db);
	const row=db.prepare('SELECT * FROM organization_capacity_enforcement_events ORDER BY version DESC LIMIT 1').get() as EnforcementRow|undefined;
	if(!row)return{mode:'disabled'};
	const record=readRow(db,row);
	if(record.mode==='disabled')return{mode:'disabled',record};
	const policy=readCurrentOrganizationCapacityPolicy(db);
	return policy&&policy.version===record.policyVersion&&policy.policySha256===record.policySha256?{mode:'enabled',record}:{mode:'blocked_policy_drift',record};
}

export class OrganizationCapacityEnforcementStore {
	readonly #db:Database.Database;readonly #now:()=>Date;
	constructor(path=dataPath('bobsled.db'),now:()=>Date=()=>new Date()){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});this.#db=new Database(path);if(path!==':memory:')chmodSync(path,0o600);this.#db.pragma('journal_mode = WAL');this.#db.pragma('busy_timeout = 5000');this.#now=now;ensureOrganizationCapacityEnforcementSchema(this.#db);}
	close():void{this.#db.close();}
	current():OrganizationCapacityEnforcementState{return readCurrentOrganizationCapacityEnforcement(this.#db);}
	history():OrganizationCapacityEnforcementRecord[]{return(this.#db.prepare('SELECT * FROM organization_capacity_enforcement_events ORDER BY version').all() as EnforcementRow[]).map((row)=>readRow(this.#db,row));}
	record(input:unknown,principal:{id:string},idempotencyKey:string):OrganizationCapacityEnforcementRecord {
		const request=v.parse(RecordRequestSchema,input),actor=v.parse(PrincipalSchema,principal);if(!idempotencyKey||idempotencyKey.length>200)throw new OrganizationCapacityEnforcementConflictError('A bounded Idempotency-Key is required');const requestSha256=digest(request);
		return this.#db.transaction(()=>{
			const replay=this.#db.prepare('SELECT * FROM organization_capacity_enforcement_events WHERE actor_id=? AND idempotency_key=?').get(actor.id,idempotencyKey) as EnforcementRow|undefined;
			if(replay){if(replay.request_sha256!==requestSha256)throw new OrganizationCapacityEnforcementConflictError('Idempotency key was already used for different enforcement input');return readRow(this.#db,replay);}
			const policy=readCurrentOrganizationCapacityPolicy(this.#db);if(!policy||policy.version!==request.expectedPolicyVersion)throw new OrganizationCapacityEnforcementConflictError('Organization capacity policy changed; reload before changing enforcement');
			const current=this.#db.prepare('SELECT version FROM organization_capacity_enforcement_events ORDER BY version DESC LIMIT 1').get() as {version:number}|undefined;
			if((current?.version??0)!==request.expectedVersion)throw new OrganizationCapacityEnforcementConflictError('Organization capacity enforcement changed; reload before updating it');
			if(request.mode==='enabled'){
				const claimsExist=this.#db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='organization_capacity_claims'").get() as {found:number}|undefined;
				const expired=claimsExist?(this.#db.prepare("SELECT COUNT(*) AS count FROM organization_capacity_claims WHERE status='active' AND expires_at<=?").get(this.#now().toISOString()) as {count:number}).count:0;
				if(expired>0)throw new OrganizationCapacityEnforcementConflictError('Expired capacity claims must be reconciled before enforcement can be enabled');
			}
			const version=(current?.version??0)+1,timestamp=this.#now().toISOString(),id=randomUUID();
			const event={id,version,mode:request.mode,policyVersion:policy.version,policySha256:policy.policySha256,actorId:actor.id,idempotencyKey,requestSha256,reason:request.reason,createdAt:timestamp},eventSha256=digest(event);
			this.#db.prepare('INSERT INTO organization_capacity_enforcement_events (id,version,mode,policy_version,policy_sha256,actor_id,idempotency_key,request_sha256,event_sha256,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,version,request.mode,policy.version,policy.policySha256,actor.id,idempotencyKey,requestSha256,eventSha256,request.reason,timestamp);
			return readRow(this.#db,this.#db.prepare('SELECT * FROM organization_capacity_enforcement_events WHERE id=?').get(id) as EnforcementRow);
		}).immediate();
	}
}

let singleton:OrganizationCapacityEnforcementStore|undefined;
function shared():OrganizationCapacityEnforcementStore{return singleton??=new OrganizationCapacityEnforcementStore();}
export const organizationCapacityEnforcementStore={
	current:():OrganizationCapacityEnforcementState=>shared().current(),
	history:():OrganizationCapacityEnforcementRecord[]=>shared().history(),
	record:(input:unknown,principal:{id:string},idempotencyKey:string):OrganizationCapacityEnforcementRecord=>shared().record(input,principal,idempotencyKey),
};
