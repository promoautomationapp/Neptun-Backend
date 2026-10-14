import { z } from "zod";

export type JsonValue =
  string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
export const jsonObject = z.record(z.string(), jsonValue);
export const identifier = z.string().min(1).max(100);
export const uuid = z.uuid();
