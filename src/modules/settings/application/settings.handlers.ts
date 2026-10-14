import { Inject } from "@nestjs/common";
import { CommandHandler, QueryHandler } from "@nestjs/cqrs";
import type { ICommandHandler, IQueryHandler } from "@nestjs/cqrs";
import { DocumentAssets } from "../../assets/document-assets";
import { jsonObject } from "../../../shared/json";
import { SettingsRepository } from "../settings.repository";
import { resolveSettings } from "../domain/settings.schema";
import { GetSettingsQuery, SaveSettingsCommand } from "./settings.messages";
@QueryHandler(GetSettingsQuery)
export class GetSettingsHandler implements IQueryHandler<GetSettingsQuery> {
  constructor(
    @Inject(SettingsRepository) private readonly repository: SettingsRepository,
  ) {}
  execute(query: GetSettingsQuery) {
    return this.repository.get(query.organizationId);
  }
}
@CommandHandler(SaveSettingsCommand)
export class SaveSettingsHandler implements ICommandHandler<SaveSettingsCommand> {
  constructor(
    @Inject(SettingsRepository) private readonly repository: SettingsRepository,
    @Inject(DocumentAssets) private readonly assets: DocumentAssets,
  ) {}
  async execute(command: SaveSettingsCommand) {
    const settings = resolveSettings(
      await this.assets.externalize(
        command.organizationId,
        jsonObject.parse(command.settings),
        command.userId,
      ),
    );
    return this.repository.save(
      command.organizationId,
      settings,
      command.expectedVersion,
    );
  }
}
