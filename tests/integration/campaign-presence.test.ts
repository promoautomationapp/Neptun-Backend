import "reflect-metadata";
import {randomUUID} from "node:crypto";
import {Database} from "../../src/database/database";
import {CampaignPresenceRepository} from "../../src/modules/documents/campaign-presence";
import type {Actor} from "../../src/modules/auth/domain/actor";

describe("shared brochure editing presence", () => {
  const db = new Database(), repository = new CampaignPresenceRepository(db);
  const campaignId = randomUUID(), firstSession = randomUUID(), secondSession = randomUUID();
  let first: Actor, second: Actor;
  beforeAll(async () => {
    const organizationId = (await db.query<{id: string}>("INSERT INTO organizations(name,slug) VALUES('Presence QA',$1) RETURNING id", [randomUUID()]))[0]!.id;
    const actor = async (label: string): Promise<Actor> => {
      const email = `${randomUUID()}@example.test`;
      const userId = (await db.query<{id: string}>("INSERT INTO users(email,password_hash,name) VALUES($1,'qa',$2) RETURNING id", [email,label]))[0]!.id;
      return {userId, organizationId, email, role: "editor", reviewRole: "staff", mustChangePassword: false};
    };
    first = await actor("First editor"); second = await actor("Second editor");
    await db.query("INSERT INTO campaigns(organization_id,id,name,layout) VALUES($1,$2,'Presence QA',$3)", [organizationId,campaignId,{id:campaignId,name:"Presence QA",products:[]}]);
  });
  afterAll(async () => {await db.onModuleDestroy();});
  test("both editors see the other person and the currently edited page", async () => {
    await repository.heartbeat(first,campaignId,{sessionId:firstSession,mode:"edit",pageLabel:"Page 2"});
    const participants = await repository.heartbeat(second,campaignId,{sessionId:secondSession,mode:"edit",pageLabel:"Cover"});
    expect(participants).toHaveLength(2);
    expect(participants).toEqual(expect.arrayContaining([expect.objectContaining({userId:first.userId,mode:"edit",pageLabel:"Page 2"}),expect.objectContaining({userId:second.userId,mode:"edit",pageLabel:"Cover"})]));
    expect(await repository.list(randomUUID(),campaignId)).toEqual([]);
  });
  test("preview changes, closing a tab and disconnected sessions do not leave stale editor status", async () => {
    const participants = await repository.heartbeat(first,campaignId,{sessionId:firstSession,mode:"preview",pageLabel:"Page 2"});
    expect(participants.find(person=>person.userId===first.userId)?.mode).toBe("preview");
    await repository.leave(first,campaignId,secondSession);
    expect(await repository.list(first.organizationId,campaignId)).toHaveLength(2);
    await repository.leave(second,campaignId,secondSession);
    expect(await repository.list(first.organizationId,campaignId)).toHaveLength(1);
    await db.query("UPDATE campaign_edit_presence SET last_seen_at=now()-interval '80 seconds' WHERE organization_id=$1 AND campaign_id=$2",[first.organizationId,campaignId]);
    expect(await repository.list(first.organizationId,campaignId)).toEqual([]);
  });
});
