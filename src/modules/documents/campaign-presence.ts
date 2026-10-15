import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  CommandBus,
  CommandHandler,
  QueryBus,
  QueryHandler,
  type ICommandHandler,
  type IQueryHandler,
} from "@nestjs/cqrs";
import { z } from "zod";
import { Database } from "../../database/database";
import { identifier } from "../../shared/json";
import type { Actor, AuthenticatedRequest } from "../auth/domain/actor";

const presenceInput = z.object({
  sessionId: z.uuid(),
  mode: z.enum(["edit", "preview"]),
  pageLabel: z.string().max(100).default(""),
});
type PresenceInput = z.infer<typeof presenceInput>;
interface PresenceRow {
  session_id: string;
  user_id: string;
  email: string;
  name: string;
  mode: "edit" | "preview";
  page_label: string;
  account_role: string;
}

@Injectable()
export class CampaignPresenceRepository {
  constructor(@Inject(Database) private readonly db: Database) {}
  async list(
    organizationId: string,
    campaignId: string,
    includeSupport = false,
  ) {
    const rows = await this.db.query<PresenceRow>(
      "SELECT p.session_id,p.user_id,u.email,u.name,p.mode,p.page_label,m.account_role FROM campaign_edit_presence p JOIN users u ON u.id=p.user_id LEFT JOIN memberships m ON m.user_id=p.user_id AND m.organization_id=p.organization_id JOIN campaigns c ON c.organization_id=p.organization_id AND c.id=p.campaign_id WHERE p.organization_id=$1 AND p.campaign_id=$2 AND c.deleted_at IS NULL AND p.last_seen_at>now()-interval '70 seconds' ORDER BY u.email,p.session_id",
      [organizationId, campaignId],
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      userId:
        !includeSupport && row.account_role === "superadmin"
          ? "workspace-team"
          : row.user_id,
      email:
        !includeSupport && row.account_role === "superadmin" ? "" : row.email,
      name:
        !includeSupport && row.account_role === "superadmin"
          ? "Workspace team"
          : row.name || "",
      mode: row.mode,
      pageLabel: row.page_label,
    }));
  }
  async heartbeat(actor: Actor, campaignId: string, input: PresenceInput) {
    const campaign = await this.db.query(
      "SELECT id FROM campaigns WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL",
      [actor.organizationId, campaignId],
    );
    if (!campaign.length) throw new NotFoundException("Campaign not found.");
    await this.db.query(
      "INSERT INTO campaign_edit_presence(organization_id,campaign_id,session_id,user_id,mode,page_label) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,campaign_id,session_id) DO UPDATE SET mode=EXCLUDED.mode,page_label=EXCLUDED.page_label,last_seen_at=now() WHERE campaign_edit_presence.user_id=EXCLUDED.user_id",
      [
        actor.organizationId,
        campaignId,
        input.sessionId,
        actor.userId,
        input.mode,
        input.pageLabel,
      ],
    );
    return this.list(
      actor.organizationId,
      campaignId,
      actor.accountRole === "superadmin",
    );
  }
  async leave(actor: Actor, campaignId: string, sessionId: string) {
    await this.db.query(
      "DELETE FROM campaign_edit_presence WHERE organization_id=$1 AND campaign_id=$2 AND session_id=$3 AND user_id=$4",
      [actor.organizationId, campaignId, sessionId, actor.userId],
    );
    return { left: true };
  }
}
export class CampaignPresenceQuery {
  constructor(
    public organizationId: string,
    public campaignId: string,
    public includeSupport = false,
  ) {}
}
export class CampaignPresenceCommand {
  constructor(
    public actor: Actor,
    public campaignId: string,
    public input: PresenceInput | { sessionId: string; leave: true },
  ) {}
}
@QueryHandler(CampaignPresenceQuery)
export class CampaignPresenceQueryHandler implements IQueryHandler<CampaignPresenceQuery> {
  constructor(
    @Inject(CampaignPresenceRepository)
    private readonly repository: CampaignPresenceRepository,
  ) {}
  execute(query: CampaignPresenceQuery) {
    return this.repository.list(
      query.organizationId,
      query.campaignId,
      query.includeSupport,
    );
  }
}
@CommandHandler(CampaignPresenceCommand)
export class CampaignPresenceCommandHandler implements ICommandHandler<CampaignPresenceCommand> {
  constructor(
    @Inject(CampaignPresenceRepository)
    private readonly repository: CampaignPresenceRepository,
  ) {}
  execute(command: CampaignPresenceCommand) {
    return "leave" in command.input
      ? this.repository.leave(
          command.actor,
          command.campaignId,
          command.input.sessionId,
        )
      : this.repository.heartbeat(
          command.actor,
          command.campaignId,
          command.input,
        );
  }
}
@Controller("api/team/campaigns")
export class CampaignPresenceController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}
  @Get(":id/presence") async list(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    return {
      participants: await this.queries.execute(
        new CampaignPresenceQuery(
          req.actor.organizationId,
          identifier.parse(id),
          req.actor.accountRole === "superadmin",
        ),
      ),
    };
  }
  @Post(":id/presence") async heartbeat(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return {
      participants: await this.commands.execute(
        new CampaignPresenceCommand(
          req.actor,
          identifier.parse(id),
          presenceInput.parse(body),
        ),
      ),
    };
  }
  @Delete(":id/presence/:sessionId") leave(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Param("sessionId") sessionId: string,
  ) {
    return this.commands.execute(
      new CampaignPresenceCommand(req.actor, identifier.parse(id), {
        sessionId: z.uuid().parse(sessionId),
        leave: true,
      }),
    );
  }
}
