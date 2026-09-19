import type { PluginSetupFields } from "../shared/plugin-verification-api";

export function readPluginSetupFields(profileValue: unknown): PluginSetupFields {
  const profile = record(profileValue, "product profile");
  const product = optionalRecord(profile.product);
  const plugin = optionalRecord(profile.plugin) ?? optionalRecord(product?.plugin);
  const legal = optionalRecord(profile.legal) ?? optionalRecord(product?.legal) ?? optionalRecord(plugin?.legal);

  const name = firstString([plugin?.name, product?.name], "plugin name", 1, 128);
  const description = firstString([plugin?.description, product?.description], "plugin description", 1, 2_048);
  const privacyUrl = absoluteHttps(firstString([plugin?.privacyUrl, legal?.privacyUrl, product?.privacyUrl], "privacy URL", 1, 2_048), "privacy URL");
  const termsUrl = absoluteHttps(firstString([plugin?.termsUrl, legal?.termsUrl, product?.termsUrl], "terms URL", 1, 2_048), "terms URL");
  const supportUrl = absoluteHttps(firstString([plugin?.supportUrl, legal?.supportUrl, product?.supportUrl], "support URL", 1, 2_048), "support URL");
  const iconCandidate = optionalFirstString([plugin?.iconUrl, product?.iconUrl], 2_048);
  const chatgptCandidate = optionalFirstString([plugin?.chatgptSetupUrl, plugin?.chatgptUrl, product?.chatgptSetupUrl], 2_048);

  return {
    name,
    description,
    authentication: "none",
    privacyUrl,
    termsUrl,
    supportUrl,
    ...(iconCandidate ? { iconUrl: absoluteHttps(iconCandidate, "plugin icon URL") } : {}),
    ...(chatgptCandidate ? { chatgptSetupUrl: absoluteHttps(chatgptCandidate, "ChatGPT setup URL") } : {}),
  };
}

function absoluteHttps(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} is not a valid URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(`${label} must be credential-free HTTPS`);
  parsed.hash = "";
  return parsed.toString();
}

function firstString(values: unknown[], label: string, min: number, max: number): string {
  const value = optionalFirstString(values, max);
  if (!value || value.length < min) throw new Error(`${label} is missing from the packaged product profile`);
  return value;
}

function optionalFirstString(values: unknown[], max: number): string | undefined {
  for (const value of values) if (typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  return undefined;
}

function record(value: unknown, label: string): Record<string, unknown> {
  const result = optionalRecord(value);
  if (!result) throw new Error(`${label} is invalid`);
  return result;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
