import { Module } from "@nestjs/common";
import { DocumentAssets } from "../assets/document-assets";
import { SettingsController } from "./settings.controller";
import { SettingsRepository } from "./settings.repository";
import {
  GetSettingsHandler,
  SaveSettingsHandler,
} from "./application/settings.handlers";
export { SettingsRepository } from "./settings.repository";
export {
  GetSettingsQuery,
  SaveSettingsCommand,
} from "./application/settings.messages";
@Module({
  controllers: [SettingsController],
  providers: [
    SettingsRepository,
    DocumentAssets,
    GetSettingsHandler,
    SaveSettingsHandler,
  ],
  exports: [SettingsRepository],
})
export class SettingsModule {}
