import { Command, Query } from "@nestjs/cqrs";
import type { SettingsSnapshot } from "../settings.repository";
import type { WorkspaceSettings } from "../domain/settings.schema";
export class GetSettingsQuery extends Query<SettingsSnapshot> {
  constructor(readonly organizationId: string) {
    super();
  }
}
export class SaveSettingsCommand extends Command<SettingsSnapshot> {
  constructor(
    readonly organizationId: string,
    readonly settings: WorkspaceSettings,
    readonly userId: string,
    readonly expectedVersion: number,
  ) {
    super();
  }
}
