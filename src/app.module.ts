import { DocumentsModule } from "./modules/documents/documents.module";
import { AiModule } from "./modules/ai/ai.module";
import { Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { DatabaseModule } from "./database/database";
import { AuthModule } from "./modules/auth/auth.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { HealthModule } from "./modules/health/health.module";
import { StorageModule } from "./modules/storage/storage.module";
import { AssetsModule } from "./modules/assets/assets.module";
import { ProductsModule } from "./modules/products/products.module";
@Module({
  imports: [
    CqrsModule.forRoot(),
    DatabaseModule,
    StorageModule,
    AuthModule,
    SettingsModule,
    AssetsModule,
    ProductsModule,
    DocumentsModule,
    AiModule,
    HealthModule,
  ],
})
export class AppModule {}
