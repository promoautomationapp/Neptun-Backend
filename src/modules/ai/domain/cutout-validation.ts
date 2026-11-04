import type { AiResultRow } from "./request";

export const CUTOUT_VALIDATION_VERSION = 1;

/** Generation is not proof of background removal. Only the byte validator may
 * issue this receipt, and an explicit designer rejection revokes it. */
export function validatedCutoutResult(row: AiResultRow): boolean {
  return (
    row.operation === "cutout" &&
    row.status === "completed" &&
    Boolean(row.output_asset_id) &&
    row.output_json?.cutoutValidated === true &&
    row.output_json.cutoutValidationVersion === CUTOUT_VALIDATION_VERSION &&
    row.output_json.cutoutRejected !== true
  );
}
