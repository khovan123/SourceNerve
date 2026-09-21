# Desktop provider CLI authentication

SourceNerve has no product-account identity-provider dependency.

Repository-provider authentication is owned by the user's existing provider CLIs:

- GitHub: `gh`
- GitLab: `glab`

Desktop reads provider state when repository operations require it and does not persist provider passwords or introduce a second provider OAuth application.

## GitHub

Authenticate with the normal GitHub CLI flow:

```bash
gh auth login
gh auth status
```

## GitLab

Authenticate with the normal GitLab CLI flow:

```bash
glab auth login
glab auth status
```

Provider credentials authorize only provider/repository operations. They are separate from the local SourceNerve bearer used by Desktop for its protected local HTTP API.

The personal ChatGPT MCP connector uses the installation-scoped Public MCP URL with **No Auth**.
