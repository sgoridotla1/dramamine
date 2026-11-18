/** URLs the debugger cannot attach to. */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return (
    /^(chrome|chrome-extension|devtools|edge|about|view-source|chrome-search|chrome-untrusted):/i.test(url) ||
    /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url)
  );
}
