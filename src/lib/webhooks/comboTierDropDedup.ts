/**
 * comboTierDropDedup.ts — edge-triggered dedupe for combo tier-drop webhooks.
 *
 * A combo whose front (premium) target dies keeps serving from a lower tier on
 * EVERY subsequent request. The operator only needs to know ONCE that the combo
 * dropped off its premium tier — not once per request, and not on a fixed
 * timer. This tracks whether each combo is currently "on premium" and only
 * signals on the DOWN edge (premium → lower). It re-arms only after the combo
 * climbs back to premium, so a sustained outage produces exactly one webhook.
 *
 * State is process-local; a restart re-arms every combo (at worst one extra
 * notification after a restart).
 */

const droppedCombos = new Set<string>();

/**
 * Records that `comboName` just served a request on `isPremium` tier. Returns
 * true only on the transition from premium (or unknown) to a lower tier — the
 * moment the combo first drops. Subsequent lower-tier requests return false
 * until the combo serves premium again (which re-arms it).
 */
export function shouldNotifyTierDrop(comboName: string, isPremium: boolean): boolean {
  if (isPremium) {
    droppedCombos.delete(comboName);
    return false;
  }
  // Already reported as dropped → stay silent until it recovers to premium.
  if (droppedCombos.has(comboName)) return false;
  droppedCombos.add(comboName);
  return true;
}

export function resetComboTierDropState(): void {
  droppedCombos.clear();
}
