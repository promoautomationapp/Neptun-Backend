import { Inject } from "@nestjs/common";
import { Command, CommandHandler, Query, QueryHandler } from "@nestjs/cqrs";
import type { ICommandHandler, IQueryHandler } from "@nestjs/cqrs";
import { AiRepository } from "../ai.repository";
import { LifestyleRepository } from "../lifestyle.repository";
import type { Actor } from "../../auth/domain/actor";
import type { AiRequest, AiTicket } from "../domain/request";
export class EnqueueAiCommand extends Command<AiTicket> {
  constructor(
    readonly actor: Actor,
    readonly request: AiRequest,
  ) {
    super();
  }
}
@CommandHandler(EnqueueAiCommand)
export class EnqueueAiHandler implements ICommandHandler<EnqueueAiCommand> {
  constructor(@Inject(AiRepository) private readonly repo: AiRepository) {}
  execute(command: EnqueueAiCommand) {
    return this.repo.enqueue(command.actor, command.request);
  }
}
export class GetAiJobQuery extends Query<
  Awaited<ReturnType<AiRepository["job"]>>
> {
  constructor(
    readonly org: string,
    readonly id: string,
  ) {
    super();
  }
}
@QueryHandler(GetAiJobQuery)
export class GetAiJobHandler implements IQueryHandler<GetAiJobQuery> {
  constructor(@Inject(AiRepository) private readonly repo: AiRepository) {}
  execute(query: GetAiJobQuery) {
    return this.repo.job(query.org, query.id);
  }
}
export class GetAiUsageQuery extends Query<
  Awaited<ReturnType<AiRepository["usage"]>>
> {
  constructor(
    readonly org: string,
    readonly month: string,
  ) {
    super();
  }
}
@QueryHandler(GetAiUsageQuery)
export class GetAiUsageHandler implements IQueryHandler<GetAiUsageQuery> {
  constructor(@Inject(AiRepository) private readonly repo: AiRepository) {}
  execute(query: GetAiUsageQuery) {
    return this.repo.usage(query.org, query.month);
  }
}
export class GetBrandLogosQuery extends Query<Record<string, string>> {
  constructor(readonly org: string) {
    super();
  }
}
@QueryHandler(GetBrandLogosQuery)
export class GetBrandLogosHandler implements IQueryHandler<GetBrandLogosQuery> {
  constructor(@Inject(AiRepository) private readonly repo: AiRepository) {}
  execute(query: GetBrandLogosQuery) {
    return this.repo.brandLogos(query.org);
  }
}
export class GetLifestyleQuotaQuery extends Query<
  Awaited<ReturnType<LifestyleRepository["quota"]>>
> {
  constructor(readonly org: string) {
    super();
  }
}
@QueryHandler(GetLifestyleQuotaQuery)
export class GetLifestyleQuotaHandler implements IQueryHandler<GetLifestyleQuotaQuery> {
  constructor(
    @Inject(LifestyleRepository) private readonly repo: LifestyleRepository,
  ) {}
  execute(query: GetLifestyleQuotaQuery) {
    return this.repo.quota(query.org);
  }
}
export class AcceptLifestyleCommand extends Command<
  Awaited<ReturnType<LifestyleRepository["accept"]>>
> {
  constructor(
    readonly org: string,
    readonly resultId: string,
  ) {
    super();
  }
}
@CommandHandler(AcceptLifestyleCommand)
export class AcceptLifestyleHandler implements ICommandHandler<AcceptLifestyleCommand> {
  constructor(
    @Inject(LifestyleRepository) private readonly repo: LifestyleRepository,
  ) {}
  execute(command: AcceptLifestyleCommand) {
    return this.repo.accept(command.org, command.resultId);
  }
}
export const aiHandlers = [
  EnqueueAiHandler,
  GetAiJobHandler,
  GetAiUsageHandler,
  GetBrandLogosHandler,
  GetLifestyleQuotaHandler,
  AcceptLifestyleHandler,
];
