# `agy` 1.1.18 `settings.json` Research

Research date: 2026-08-22

## Short Answer

The installed `/opt/homebrew/bin/agy` is version `1.1.18` (SHA-256
`14da0bcd9fc7fc2e4337813f5e386bc3ab9dcdfc1362f35c1076af89ac57d51b`). Its
persistent settings file is:

```text
~/.gemini/antigravity-cli/settings.json
```

The official Antigravity CLI reference documents a flat JSON object with the
keys and values in the table below. The public pages are labelled CLI `v1.1.17`,
so they are authoritative documentation for the closest published version, not
a version-matched `1.1.18` schema.

The binary contains implementation evidence for `trustedWorkspaces` and
workspace-trust code, but neither the official Antigravity settings table nor
the binary evidence establishes a complete public trust schema. In particular,
`trustAllWorkspaces` is present in the local file but was not found as a JSON
field/tag in the installed binary and is not documented. Its effect is
unresolved.

## Documented Antigravity Settings

These are the values explicitly documented by the official Antigravity CLI
reference and settings pages. Confidence is high for the documented contract,
with the version caveat above.

| Key | JSON type and accepted values | Documented default |
| --- | --- | --- |
| `colorScheme` | String: `light`, `solarized light`, `colorblind-friendly light`, `dark`, `solarized dark`, `colorblind-friendly dark`, `tokyo night`, `terminal` | `terminal` |
| `altScreenMode` | String: `default`, `always`, `never` | `default` |
| `toolPermission` | String: `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict` | `request-review` |
| `artifactReviewPolicy` | String: `asks-for-review`, `agent-decides`, `always-proceed` | `asks-for-review` |
| `notifications` | Boolean | `false` |
| `showTips` | Boolean | `true` |
| `showFeedbackSurvey` | Boolean | `true` |
| `editor` | String: `auto`, `vim`, `emacs`, or a custom text label | `auto` |
| `editorMode` | String: `default`, `vim` | `default` |
| `vimInsertFirst` | Boolean; only applies when `editorMode` is `vim` | `false` |
| `allowNonWorkspaceAccess` | Boolean; controls reads/writes outside active project directories | `false` |
| `enableTerminalSandbox` | Boolean | `false` |
| `useG1Credits` | Boolean; marked external-build-only | `false` |
| `enableTelemetry` | Boolean | `true` |
| `verbosity` | String: `high`, `low` | `high` |
| `runningLightSpeed` | String: `fast`, `medium`, `slow`, `off` | `medium` |

The documented example is equivalent to:

```json
{
  "colorScheme": "tokyo night",
  "altScreenMode": "always",
  "toolPermission": "request-review",
  "notifications": true,
  "enableTerminalSandbox": true
}
```

The settings file is sparse: the CLI writes values that differ from defaults,
rather than a full default-filled object. `/config` and `/settings` open the
interactive settings editor, and command-line flags can override persisted
settings for the current session. Keybindings are separate:
`~/.gemini/antigravity-cli/keybindings.json`.

## Documented `permissions` Object

Permissions are documented separately from the settings table. The supported
shape is:

```json
{
  "permissions": {
    "allow": [],
    "deny": [],
    "ask": []
  }
}
```

Each array contains permission-resource strings. The documented forms are:

```text
read_file(path|dir|*)
write_file(path|*)
read_url(domain|*)
execute_url(domain|*)
command(prefix|regex|*)
unsandboxed(prefix|*)
mcp(server/tool|server/*|*)
```

The `|` notation above means the resource-specific form described by the
documentation, not a literal pipe-separated value. `*` is the wildcard. Rule
precedence is Deny, then Ask, then Allow. Workspace file access is auto-allowed
in standard operation; unconfigured commands, MCP actions, URLs, and
non-workspace files default to Ask.

## Installed Binary Evidence

The installed executable is a native arm64 Mach-O binary signed by Google LLC.
`agy --version` returns `1.1.18`; `agy --help` exposes settings-related flags
but no settings-schema subcommand. `agy agent --help`, `agy models --help`,
`agy changelog --help`, and `agy install --help` likewise do not expose a
machine-readable settings schema.

The binary's Go symbol and string tables contain these relevant implementation
symbols:

```text
google3/third_party/jetski/cli/types/types.DefaultCliSetting
google3/third_party/jetski/cli/types/types.CliSetting.MarshalSparse
google3/third_party/jetski/cli/types/types.CliSetting.MarshalFull
google3/third_party/jetski/cli/types/types.ParseSettingsFields
google3/third_party/jetski/cli/types/types.(*CliSetting).UnmarshalJSON
google3/third_party/jetski/cli/types/types.(*CliSetting).IsTrustedWorkspace
google3/third_party/jetski/cli/store/store.(*Store).workspaceTrusted
google3/third_party/jetski/cli/model/model.WorkspaceTrustModel
json:"trustedWorkspaces,omitempty"
json:"workspaceTrust"
```

The same binary contains JSON tags for documented keys such as
`allowNonWorkspaceAccess`, `artifactReviewPolicy`, `colorScheme`,
`enableTerminalSandbox`, `enableTelemetry`, `runningLightSpeed`,
`showFeedbackSurvey`, `showTips`, `toolPermission`, `verbosity`, and
`vimInsertFirst`. This is strong evidence that the public flat settings model
is implemented in the installed executable.

A targeted search found no `trustAllWorkspaces` string and no
`json:"trustAllWorkspaces...` tag in the executable. That absence does not
prove that the key is rejected, because this is a stripped native binary and
unknown-field preservation is possible; it does mean there is no supporting
field evidence comparable to `trustedWorkspaces`.

The `agy changelog` output also reports that version `1.0.7` preserved unknown
`settings.json` fields during read/write/merge. Therefore, a key surviving in
the file is not proof that the current CLI reads or applies it.

## Workspace and Folder Trust

### `allowNonWorkspaceAccess`

This is the only trust-adjacent setting documented in the public Antigravity
settings table. It is a boolean, defaults to `false`, and controls whether the
agent may read or write outside the active project directories. It is not the
same thing as deciding whether the current workspace is trusted.

### `trustedWorkspaces`

Evidence level: **medium, implementation-inferred**.

The installed binary has a `json:"trustedWorkspaces,omitempty"` field/tag and
workspace-trust methods, and the local runtime file contains an array of
absolute path strings. The safest schema statement supported by those sources
is:

```json
{
  "trustedWorkspaces": ["/absolute/path/to/a/workspace"]
}
```

The following are **not established** by the available primary sources:

- Whether paths must be absolute, although the observed values are absolute.
- Whether a parent path automatically trusts descendants.
- Whether matching is exact, hierarchical, canonicalized, or symlink-aware.
- Case sensitivity, path normalization, duplicate handling, or empty-list behavior.
- Whether this field is user-editable in `/config` or only serialized state.

Do not treat `trustedWorkspaces` as having a documented wildcard or special
value. No such value was found in the public Antigravity docs.

### `trustAllWorkspaces`

Evidence level: **low, local-only and undocumented**.

The current `/Users/host/.gemini/antigravity-cli/settings.json` contains:

```json
"trustAllWorkspaces": true
```

However, the key is absent from the public Antigravity settings documentation,
was not found as a JSON tag in `/opt/homebrew/bin/agy`, and has no confirmed
semantics in the available binary evidence. It may be an application-specific
or legacy field, an unknown field preserved by the settings merger, or an
effective private setting. The accepted value appears boolean only because the
local file uses `true`; that is not sufficient to call it an accepted or
effective `agy` 1.1.18 setting.

### `workspaceTrust`

Evidence level: **low, internal/undocumented**.

The executable contains `json:"workspaceTrust"` and a
`WorkspaceTrustModel`, but no public type, value list, or settings-table entry
was found. It may be internal serialized UI/store state rather than a
user-writable settings property. Its type and accepted values are unresolved.

### Separate Gemini CLI trust state

The separate file `/Users/host/.gemini/trustedFolders.json` currently contains
a path mapped to `"TRUST_FOLDER"`. Official Gemini CLI documentation describes
that file and the choices `Trust folder`, `Trust parent folder`, and `Don't
trust`. This is the Gemini CLI's documented folder-trust mechanism, not a
documented schema for Antigravity CLI's flat `settings.json`. Do not substitute
Gemini CLI's nested setting below into the Antigravity file:

```json
{
  "security": {
    "folderTrust": {
      "enabled": true
    }
  }
}
```

## Observed Local Keys That Are Not Publicly Documented

The current local Antigravity file also contains `model`, `disableFeedback`,
`disableSurveys`, nested `telemetry.enabled`, and `trustedWorkspaces`. The
binary contains additional JSON names including `copyOnSelect`,
`clearScrollbackOnResize`, `statusLine`, `agentMode`, `pickerGrouping`, and
`customModelsConfig`. Because the executable contains many unrelated JSON
types, string-table evidence alone cannot assign every such name to the
persisted `CliSetting` object.

These should be classified as **private, legacy, or inferred** until a
version-matched schema or behavior test proves otherwise. In particular:

- `enableTelemetry` is the documented flat key; `telemetry.enabled` is not a
  documented equivalent.
- `showFeedbackSurvey` is documented; `disableFeedback` and `disableSurveys`
  are not documented settings keys.
- `model` is used by the local file and appears in binary JSON metadata, but its
  accepted model-name values are not defined by the settings reference.

## Sources and Confidence

### Primary installed sources

- `/opt/homebrew/bin/agy` - inspected with `--version`, `--help`, `changelog`,
  `strings`, `go version -m`, `otool -l`, `file`, and `codesign`; version
  `1.1.18`, SHA-256 recorded above. **High confidence for observed binary facts;
  medium or lower for semantics inferred from symbols.**
- `/Users/host/.gemini/antigravity-cli/settings.json` - current runtime
  observation, not schema documentation. **High confidence for what is present;
  low confidence for support/effect of undocumented keys.**
- `/Users/host/.gemini/trustedFolders.json` - current Gemini trust-state
  observation, not Antigravity settings schema. **High confidence for the local
  file contents only.**
- `/Users/host/.gemini/antigravity-cli/builtin/skills/antigravity_guide/references/cli.md`
  - first-party installed pointer identifying the settings path and official
  docs. **High confidence as a pointer; it defers schema claims to live docs.**

### Official Antigravity documentation

- [CLI reference](https://antigravity.google/docs/cli/reference) - documented
  flat settings keys, enums, types, defaults, and example. The page is labelled
  CLI `v1.1.17`.
- [CLI settings](https://antigravity.google/docs/cli/settings) - sparse
  persistence, `/config`/`/settings`, overrides, and settings-file behavior.
- [CLI permissions](https://antigravity.google/docs/cli/permissions) -
  permission object, resource syntax, and precedence.
- [CLI features](https://antigravity.google/docs/cli/features),
  [sandbox](https://antigravity.google/docs/cli/sandbox), and
  [using](https://antigravity.google/docs/cli/using) - corroborating settings,
  permission, and sandbox behavior.

These are the authoritative sources for the documented Antigravity contract,
but their visible version label is `1.1.17`, not `1.1.18`.

### Official Gemini CLI comparison sources

- [Gemini CLI trusted folders](https://geminicli.com/docs/cli/trusted-folders/)
- [Gemini CLI settings](https://geminicli.com/docs/cli/settings/)
- [Gemini CLI configuration reference](https://geminicli.com/docs/reference/configuration)
- [Gemini CLI settings schema](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json)

These are official lineage/comparison sources only. Gemini CLI uses a different
nested settings schema and must not be presented as Antigravity CLI's schema.

## Unresolved Uncertainty

1. The official Antigravity docs are labelled `v1.1.17`; no public, exact
   `1.1.18` Antigravity settings schema was found.
2. No public Antigravity CLI source repository or machine-readable schema was
   found. The installed binary has no DWARF section, limiting source-level
   extraction.
3. The exact accepted type, values, and semantics of `workspaceTrust` are
   unknown.
4. `trustedWorkspaces` is evidenced as a serialized field and observed as an
   array of paths, but path matching and inheritance semantics are unknown.
5. `trustAllWorkspaces` is present locally but has no matching public or binary
   field evidence; whether `agy` 1.1.18 applies it is unknown.
6. Private/legacy keys may be preserved without being read or acted upon.
