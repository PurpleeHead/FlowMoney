export async function isDatabaseReady(
  probe: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}
