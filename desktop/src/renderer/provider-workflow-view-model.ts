export function providerLabel(provider: "github" | "gitlab"): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

export function providerChangeLabel(provider: "github" | "gitlab"): string {
  return provider === "github" ? "Pull Request" : "Merge Request";
}

export function shortProviderSha(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
