import { Inject } from "@nestjs/common";
import { Command, CommandHandler, Query, QueryHandler } from "@nestjs/cqrs";
import type { ICommandHandler, IQueryHandler } from "@nestjs/cqrs";
import { DocumentsRepository } from "../documents.repository";
import type { Actor } from "../../auth/domain/actor";
import type { Campaign, Post, DocumentKind } from "../domain/document";
import type { ReviewInput } from "../domain/review";
export class ListDocumentsQuery extends Query<(Campaign | Post)[]> {
  constructor(
    readonly organizationId: string,
    readonly kind: DocumentKind,
    readonly includeDisabled = false,
  ) {
    super();
  }
}
export class GetDocumentQuery extends Query<Campaign | Post> {
  constructor(
    readonly organizationId: string,
    readonly kind: DocumentKind,
    readonly id: string,
    readonly includeDisabled = false,
  ) {
    super();
  }
}
export class SaveDocumentCommand extends Command<Campaign | Post> {
  constructor(
    readonly actor: Actor,
    readonly kind: DocumentKind,
    readonly document: Campaign | Post,
  ) {
    super();
  }
}
export class RemoveDocumentCommand extends Command<{ deleted: boolean }> {
  constructor(
    readonly actor: Actor,
    readonly kind: DocumentKind,
    readonly id: string,
    readonly version?: number,
  ) {
    super();
  }
}
export class RestoreDocumentCommand extends Command<Campaign | Post> {
  constructor(
    readonly actor: Actor,
    readonly kind: DocumentKind,
    readonly id: string,
    readonly version?: number,
  ) {
    super();
  }
}
export class ReviewCampaignCommand extends Command<Campaign> {
  constructor(
    readonly actor: Actor,
    readonly id: string,
    readonly input: ReviewInput,
  ) {
    super();
  }
}
@QueryHandler(ListDocumentsQuery)
export class ListDocumentsHandler implements IQueryHandler<ListDocumentsQuery> {
  constructor(
    @Inject(DocumentsRepository)
    private readonly repository: DocumentsRepository,
  ) {}
  execute(query: ListDocumentsQuery) {
    return this.repository.list(
      query.organizationId,
      query.kind,
      query.includeDisabled,
    );
  }
}
@QueryHandler(GetDocumentQuery)
export class GetDocumentHandler implements IQueryHandler<GetDocumentQuery> {
  constructor(
    @Inject(DocumentsRepository)
    private readonly repository: DocumentsRepository,
  ) {}
  execute(query: GetDocumentQuery) {
    return this.repository.get(
      query.organizationId,
      query.kind,
      query.id,
      query.includeDisabled,
    );
  }
}
@CommandHandler(SaveDocumentCommand)
export class SaveDocumentHandler implements ICommandHandler<SaveDocumentCommand> {
  constructor(
    @Inject(DocumentsRepository)
    private readonly repository: DocumentsRepository,
  ) {}
  execute(command: SaveDocumentCommand) {
    return this.repository.save(command.actor, command.kind, command.document);
  }
}
@CommandHandler(RemoveDocumentCommand)
export class RemoveDocumentHandler implements ICommandHandler<RemoveDocumentCommand> {
  constructor(
    @Inject(DocumentsRepository)
    private readonly repository: DocumentsRepository,
  ) {}
  execute(command: RemoveDocumentCommand) {
    return this.repository.remove(
      command.actor,
      command.kind,
      command.id,
      command.version,
    );
  }
}
@CommandHandler(RestoreDocumentCommand)
export class RestoreDocumentHandler implements ICommandHandler<RestoreDocumentCommand> {
  constructor(
    @Inject(DocumentsRepository)
    private readonly repository: DocumentsRepository,
  ) {}
  execute(command: RestoreDocumentCommand) {
    return this.repository.restore(
      command.actor,
      command.kind,
      command.id,
      command.version,
    );
  }
}
@CommandHandler(ReviewCampaignCommand)
export class ReviewCampaignHandler implements ICommandHandler<ReviewCampaignCommand> {
  constructor(
    @Inject(DocumentsRepository)
    private readonly repository: DocumentsRepository,
  ) {}
  execute(command: ReviewCampaignCommand) {
    return this.repository.review(command.actor, command.id, command.input);
  }
}
export const documentHandlers = [
  ListDocumentsHandler,
  GetDocumentHandler,
  SaveDocumentHandler,
  RemoveDocumentHandler,
  RestoreDocumentHandler,
  ReviewCampaignHandler,
];
