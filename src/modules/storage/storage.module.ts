import { Global, Module } from "@nestjs/common";
import { STORAGE } from "./storage.port";
import { LocalStorage } from "./local.storage";
import { R2Storage } from "./r2.storage";
import { env } from "../../config/environment";
@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      useFactory: () =>
        env.STORAGE_DRIVER === "r2"
          ? new R2Storage()
          : new LocalStorage(env.LOCAL_STORAGE_DIR),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
